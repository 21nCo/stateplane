import Foundation
import Security

// Tokens cross this process boundary only on stdin/stdout, never in argv.
guard CommandLine.arguments.count == 3 else { exit(1) }
let operation = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrAccount as String: "default",
  kSecAttrService as String: service
]

// This helper only deletes legacy items. A Swift interpreter has no caller
// identity that can safely restrict credential reads to Stateplane.
if operation == "remove" {
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { exit(1) }
} else { exit(1) }
