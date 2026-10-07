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
  // A Swift CLI has no Data Protection Keychain entitlement on this host.
  // An interpreter cannot be trusted as the calling application: any other
  // Swift script would inherit its trust. Require a Keychain prompt instead.
  var access: SecAccess?
  let accessStatus = SecAccessCreate("Stateplane API key" as CFString, [] as CFArray, &access)
  guard accessStatus == errSecSuccess,
    let access = access else { exit(1) }
  var item = query
  item[kSecValueData as String] = token
  item[kSecAttrAccess as String] = access
  let added = SecItemAdd(item as CFDictionary, nil) // NOSONAR -- empty trusted-app ACL requires confirmation for decryption
  let status = added == errSecDuplicateItem
    ? SecItemUpdate(query as CFDictionary, [ // NOSONAR -- update replaces legacy caller trust with the prompt-only ACL
        kSecValueData as String: token,
        kSecAttrAccess as String: access
      ] as CFDictionary)
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
