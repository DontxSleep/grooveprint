import AppKit
import Foundation
import UniformTypeIdentifiers
import WebKit

@MainActor
final class GrooveprintApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private let microphone = GrooveMicrophone()
    private let selfTestURL: URL?
    private let fixtureURL: URL?
    private var window: NSWindow?
    private var contentURL: URL?
    private var capturedAudio: Data?
    private var fixtureRecording = false
    private var testing = false
    private var saving = false

    init(arguments: [String]) {
        func url(after flag: String) -> URL? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return URL(fileURLWithPath: arguments[index + 1])
        }
        selfTestURL = url(after: "--self-test")
        fixtureURL = url(after: "--fixture")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let application = NSApplication.shared
        let testing = selfTestURL != nil
        application.setActivationPolicy(testing ? .accessory : .regular)

        guard let contentURL = Bundle.main.url(forResource: "Grooveprint", withExtension: "html") else {
            showStartupFailure("Grooveprint is missing its interface. Copy a fresh app from the disk image.")
            return
        }
        self.contentURL = contentURL.standardizedFileURL

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.isTextInteractionEnabled = true
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "grooveprint")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = NSColor(srgbRed: 8 / 255, green: 13 / 255, blue: 25 / 255, alpha: 1)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "Grooveprint"
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentMinSize = NSSize(width: 360, height: 480)
        window.contentView = web
        window.isReleasedWhenClosed = false
        self.window = window
        web.loadFileURL(contentURL, allowingReadAccessTo: contentURL)

        if !testing {
            installMenus()
            let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
            if let visible {
                window.setContentSize(NSSize(width: min(1120, visible.width - 50), height: min(880, visible.height - 55)))
            }
            window.center()
            window.makeKeyAndOrderFront(nil)
            application.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        microphone.cancel()
        capturedAudio = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let localDocument = action.request.url?.standardizedFileURL == contentURL
        decisionHandler(localDocument && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if selfTestURL != nil, !testing {
            testing = true
            runSelfTest(webView)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showStartupFailure(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showStartupFailure(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        microphone.cancel()
        capturedAudio = nil
        showStartupFailure("The Grooveprint interface stopped unexpectedly. Quit and reopen the app.")
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let window else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.title = "Import Audio"
        panel.prompt = "Import"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.audio]
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler reply: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.name == "grooveprint",
              let contentURL, message.frameInfo.request.url?.standardizedFileURL == contentURL,
              let command = message.body as? [String: Any], let action = command["action"] as? String else {
            reply(nil, "The recording interface could not reach Grooveprint.")
            return
        }

        switch action {
        case "start":
            capturedAudio = nil
            if selfTestURL != nil {
                guard fixtureURL != nil else { reply(nil, "Missing test audio."); return }
                fixtureRecording = true
                reply(true, nil)
                return
            }
            Task { @MainActor in
                do {
                    try await microphone.start()
                    reply(true, nil)
                } catch is CancellationError {
                    reply(false, nil)
                } catch {
                    reply(nil, error.localizedDescription)
                }
            }
        case "meter":
            reply(fixtureRecording ? 0.25 : microphone.meter(), nil)
        case "stop":
            do {
                if fixtureRecording, let fixtureURL {
                    fixtureRecording = false
                    capturedAudio = try Data(contentsOf: fixtureURL)
                } else if selfTestURL == nil {
                    capturedAudio = try microphone.stop()
                }
                guard let capturedAudio, !capturedAudio.isEmpty else {
                    reply(nil, "No audio was captured. Try another take.")
                    return
                }
                reply(capturedAudio.count, nil)
            } catch {
                capturedAudio = nil
                reply(nil, error.localizedDescription)
            }
        case "read":
            guard let data = capturedAudio, let offset = command["offset"] as? Int,
                  offset >= 0 && offset < data.count else {
                reply(nil, "The recording could not be read. Try another take.")
                return
            }
            let end = min(data.count, offset + 256 * 1024)
            reply(data[offset..<end].base64EncodedString(), nil)
        case "release":
            capturedAudio = nil
            reply(true, nil)
        case "cancel":
            fixtureRecording = false
            microphone.cancel()
            capturedAudio = nil
            reply(true, nil)
        case "loadAppearance":
            let appearance = selfTestURL == nil
                ? UserDefaults.standard.dictionary(forKey: "Appearance") : nil
            reply(appearance ?? [:], nil)
        case "saveAppearance":
            guard let skin = command["skin"] as? String, let background = command["background"] as? String,
                  skin.count <= 32, background.count <= 32 else {
                reply(nil, "The appearance setting could not be saved.")
                return
            }
            if selfTestURL == nil {
                UserDefaults.standard.set(["skin": skin, "background": background], forKey: "Appearance")
            }
            reply(true, nil)
        case "saveMidi":
            guard let encoded = command["bytes"] as? String, encoded.utf8.count <= 2_000_000,
                  let midi = Data(base64Encoded: encoded),
                  midi.prefix(4) == Data("MThd".utf8), midi.count >= 22,
                  let filename = command["name"] as? String else {
                reply(nil, "The MIDI file could not be prepared.")
                return
            }
            saveMidi(midi, suggestedName: filename, reply: reply)
        default:
            reply(nil, "Grooveprint did not recognize this action.")
        }
    }

    private func saveMidi(_ midi: Data, suggestedName: String, reply: @escaping (Any?, String?) -> Void) {
        func write(to url: URL) {
            do {
                try midi.write(to: url, options: .atomic)
                reply(true, nil)
            } catch {
                reply(nil, "The MIDI file could not be saved. " + error.localizedDescription)
            }
        }

        if let selfTestURL {
            write(to: selfTestURL.deletingPathExtension().appendingPathExtension("mid"))
            return
        }
        guard let window, !saving else { reply(false, nil); return }
        saving = true
        let panel = NSSavePanel()
        panel.title = "Save MIDI Clip"
        panel.prompt = "Save"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedName).lastPathComponent
        panel.allowedContentTypes = [.midi]
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            self?.saving = false
            if response == .OK, let url = panel.url { write(to: url) }
            else { reply(false, nil) }
        }
    }

    private func runSelfTest(_ webView: WKWebView) {
        let script = """
        const get = id => document.getElementById(id);
        const status = () => get('status').textContent;
        const until = async (check, description) => {
          const deadline = Date.now() + 6500;
          while (Date.now() < deadline) {
            if (check()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error(description + ' — ' + status());
        };
        await until(() => get('take-meta').textContent.includes('Demo phrase · 8 notes'), 'Demo did not load');
        if (!window.webkit?.messageHandlers?.grooveprint || !get('export').textContent.includes('Save MIDI')) {
          throw new Error('Native bridge not available');
        }
        const style = getComputedStyle(document.body, '::before').backgroundImage;
        if (!style.includes('data:image/webp')) throw new Error('Local artwork missing');
        get('record').click();
        await until(() => get('record-label').textContent === 'Stop recording', 'Capture did not start');
        get('record').click();
        await until(() => get('take-meta').textContent.includes('Microphone take · 5 notes'), 'Capture did not produce five notes');
        const title = get('take-meta').textContent;
        const tempo = get('tempo');
        tempo.value = 137;
        tempo.dispatchEvent(new Event('change'));
        get('export').click();
        await until(() => status() === 'MIDI saved at 137 BPM.', 'File was not saved');
        return {ok:true, demoNotes:8, captureNotes:5, take:title, exportBPM:137, embeddedArtwork:true};
        """
        Task { @MainActor in
            do {
                let value = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
                guard let report = value as? [String: Any], report["ok"] as? Bool == true else {
                    finishTest(["ok": false, "error": "Unexpected test report."])
                    return
                }
                finishTest(report)
            } catch {
                finishTest(["ok": false, "error": error.localizedDescription, "details": (error as NSError).userInfo.description])
            }
        }
    }

    private func finishTest(_ report: [String: Any]) {
        guard let selfTestURL else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: selfTestURL, options: .atomic)
        } catch {
            fputs(error.localizedDescription + "\n", stderr)
            exit(1)
        }
        exit(report["ok"] as? Bool == true ? 0 : 1)
    }

    private func showStartupFailure(_ message: String) {
        if selfTestURL != nil {
            finishTest(["ok": false, "error": message])
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Grooveprint could not open"
        alert.informativeText = message
        alert.runModal()
        NSApplication.shared.terminate(nil)
    }

    private func installMenus() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Grooveprint", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Grooveprint", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Grooveprint", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        NSApplication.shared.windowsMenu = windowMenu
        NSApplication.shared.mainMenu = mainMenu
    }
}

@main
enum GrooveprintMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = GrooveprintApp(arguments: CommandLine.arguments)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
