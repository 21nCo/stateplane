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

if operation == "store" {
  let token = FileHandle.standardInput.readDataToEndOfFile()
  guard !token.isEmpty else { exit(1) }
  var item = query
  item[kSecValueData as String] = token
  let added = SecItemAdd(item as CFDictionary, nil)
  let status = added == errSecDuplicateItem
    ? SecItemUpdate(query as CFDictionary, [kSecValueData as String: token] as CFDictionary)
    : added
  guard status == errSecSuccess else { exit(1) }
} else if operation == "load" {
  var request = query
  request[kSecReturnData as String] = true
  request[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(request as CFDictionary, &result)
  guard status != errSecItemNotFound else { exit(2) }
  guard status == errSecSuccess, let token = result as? Data else { exit(1) }
  FileHandle.standardOutput.write(token)
} else if operation == "remove" {
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { exit(1) }
} else { exit(1) }
