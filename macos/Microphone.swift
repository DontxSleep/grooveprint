import AVFoundation
import Foundation

@MainActor
final class GrooveMicrophone {
    private enum State {
        case idle
        case requestingPermission(UUID)
        case recording(AVAudioRecorder)
    }

    private enum RecordingError: LocalizedError {
        case alreadyRecording
        case permissionDenied
        case couldNotStart
        case noRecording
        case couldNotRead

        var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "A recording is already in progress."
            case .permissionDenied:
                return "Allow Grooveprint to use the microphone in System Settings → Privacy & Security → Microphone."
            case .couldNotStart:
                return "The microphone could not start. Check your input device in System Settings → Sound."
            case .noRecording:
                return "There is no recording to finish."
            case .couldNotRead:
                return "The recording could not be read. Try another take."
            }
        }
    }

    private var state: State = .idle
    private let fileManager = FileManager.default

    func start() async throws {
        guard case .idle = state else { throw RecordingError.alreadyRecording }

        let requestID = UUID()
        state = .requestingPermission(requestID)
        defer {
            if case .requestingPermission(let pendingID) = state, pendingID == requestID {
                state = .idle
            }
        }

        let allowed = await microphoneAllowed()
        try Task.checkCancellation()
        guard case .requestingPermission(let pendingID) = state, pendingID == requestID else {
            throw CancellationError()
        }
        guard allowed else { throw RecordingError.permissionDenied }

        let folder = fileManager.temporaryDirectory
            .appendingPathComponent("Grooveprint-\(requestID.uuidString)", isDirectory: true)
        let file = folder.appendingPathComponent("Take.wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false
        ]

        do {
            try fileManager.createDirectory(
                at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]
            )
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            recorder.isMeteringEnabled = true
            // The interface also stops after five minutes. Cap the capture here in case the page stalls.
            guard recorder.record(forDuration: 300) else { throw RecordingError.couldNotStart }
            state = .recording(recorder)
        } catch {
            try? fileManager.removeItem(at: folder)
            throw RecordingError.couldNotStart
        }
    }

    func stop() throws -> Data {
        guard case .recording(let recorder) = state else { throw RecordingError.noRecording }
        state = .idle
        recorder.stop()
        defer { removeRecording(recorder) }

        do {
            return try Data(contentsOf: recorder.url)
        } catch {
            throw RecordingError.couldNotRead
        }
    }

    func meter() -> Double {
        guard case .recording(let recorder) = state, recorder.isRecording else { return 0 }
        recorder.updateMeters()
        let averagePower = Double(recorder.averagePower(forChannel: 0))
        guard averagePower.isFinite else { return 0 }
        return min(1, pow(10, averagePower / 20))
    }

    func cancel() {
        let previous = state
        state = .idle
        if case .recording(let recorder) = previous {
            recorder.stop()
            removeRecording(recorder)
        }
    }

    private func microphoneAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    private func removeRecording(_ recorder: AVAudioRecorder) {
        try? fileManager.removeItem(at: recorder.url.deletingLastPathComponent())
    }
}
