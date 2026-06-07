import Foundation
@main struct Main {
    static func main() {
        let a = CommandLine.arguments
        guard a.count > 1 else { exit(0) }
        switch a[1] {
        case "snapshot": snapshot()
        case "list-snapshots", "list": list()
        case "rollback": if a.count > 2 { rollback(a[2]) }
        case "cleanup": cleanup(maxKeep: a.count > 2 ? Int(a[2]) ?? 10 : 10)
        case "check-command": if a.count > 2 { checkCommand(Array(a.dropFirst(2))) }
        default: exit(0)
        }
    }
    
    static func snapshot() {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); p.arguments = ["localsnapshot", "/"]
        let o = Pipe(), e = Pipe(); p.standardOutput = o; p.standardError = e
        try? p.run(); p.waitUntilExit()
        let time = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        print(p.terminationStatus == 0 ? "{\"status\":\"success\",\"snapshotName\":\"pi-protect-\(time)\"}" : "{\"status\":\"error\"}")
    }
    
    static func list() {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); p.arguments = ["listlocalsnapshots", "/"]
        let o = Pipe(); p.standardOutput = o; try? p.run(); p.waitUntilExit()
        let s = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.split(separator: "\n").map(String.init).filter{$0.contains("TimeMachine")}.sorted() ?? []
        print("{\"status\":\"success\",\"snapshots\":\(s)}")
    }
    
    static func rollback(_ n: String) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); p.arguments = ["listlocalsnapshots", "/"]
        let o = Pipe(); p.standardOutput = o; try? p.run(); p.waitUntilExit()
        let all = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.split(separator: "\n").map(String.init).filter{$0.contains("TimeMachine")}.sorted() ?? []
        if let i = all.firstIndex(of: n) {
            // Delete NEWER snapshots (after target), not older ones
            for x in all[(i+1)...] {
                let d = x.replacingOccurrences(of: "com.apple.TimeMachine.", with: "").replacingOccurrences(of: ".local", with: "")
                let q = Process(); q.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); q.arguments = ["deletelocalsnapshots", d]; try? q.run(); q.waitUntilExit()
            }
            print("{\"status\":\"success\",\"deleted\":\(all.count - i - 1)}")
        } else { print("{\"status\":\"error\",\"error\":\"not found: \(n)\"}") }
    }
    
    static func cleanup(maxKeep: Int) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); p.arguments = ["listlocalsnapshots", "/"]
        let o = Pipe(); p.standardOutput = o; try? p.run(); p.waitUntilExit()
        let all = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.split(separator: "\n").map(String.init).filter{$0.contains("TimeMachine")}.sorted() ?? []
        let toDelete = max(0, all.count - maxKeep)
        for x in all[..<toDelete] {
            let d = x.replacingOccurrences(of: "com.apple.TimeMachine.", with: "").replacingOccurrences(of: ".local", with: "")
            let q = Process(); q.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil"); q.arguments = ["deletelocalsnapshots", d]; try? q.run(); q.waitUntilExit()
        }
        print("{\"status\":\"success\",\"deleted\":\(toDelete),\"kept\":\(min(all.count, maxKeep))}")
    }
    
    static func checkCommand(_ args: [String]) {
        let cmd = args.joined(separator: " ")
        var (c, h, m) = (false, false, false)
        let patterns: [(String, String)] = [
            (#"rm\s+-rf\s+/"#, "c"), (#"rm\s+-rf\s+\*"#, "c"), (#"rm\s+-rf"#, "h"),
            (#"rm\s+"#, "m"), (#"dd\s+"#, "h"), (#"mkfs"#, "c"), (#"chmod\s+-R\s+777"#, "h")
        ]
        for (pat, sev) in patterns {
            if let r = try? NSRegularExpression(pattern: pat), !r.matches(in: cmd, range: NSRange(cmd.startIndex..., in: cmd)).isEmpty {
                if sev == "c" { c = true } else if sev == "h" { h = true } else { m = true }
            }
        }
        let block = c || h
        print("{\"command\":\"\(cmd.replacingOccurrences(of: "\"", with: "\\\""))\",\"shouldBlock\":\(block),\"critical\":\(c),\"high\":\(h),\"medium\":\(m)}")
    }
}
