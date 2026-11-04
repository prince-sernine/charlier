using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class Program {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] int flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr credentialPtr);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static int Main(string[] args) {
        if (args.Length < 1) {
            Console.Error.WriteLine("Usage: charlier-cred.exe <read|write|delete> [target] [user] [secret-or-stdin]");
            return 1;
        }

        string cmd = args[0].ToLowerInvariant();
        string target = args.Length > 1 ? args[1] : "gemini:antigravity";

        if (cmd == "read") {
            IntPtr ptr;
            if (CredRead(target, 1, 0, out ptr)) {
                var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
                byte[] bytes = new byte[cred.CredentialBlobSize];
                Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
                CredFree(ptr);
                Console.OutputEncoding = Encoding.UTF8;
                Console.Write(Encoding.UTF8.GetString(bytes));
                return 0;
            }
            return 2; // Not found
        }
        else if (cmd == "delete") {
            bool ok = CredDelete(target, 1, 0);
            return ok ? 0 : 3;
        }
        else if (cmd == "write") {
            string user = args.Length > 2 ? args[2] : "antigravity";
            string secret = null;
            if (args.Length > 3) {
                secret = args[3];
            } else {
                using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) {
                    secret = reader.ReadToEnd();
                }
            }

            if (string.IsNullOrEmpty(secret)) {
                Console.Error.WriteLine("Error: Empty secret");
                return 4;
            }

            byte[] bytes = Encoding.UTF8.GetBytes(secret);
            IntPtr blobPtr = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, blobPtr, bytes.Length);

            var cred = new CREDENTIAL {
                Type = 1, // CRED_TYPE_GENERIC
                TargetName = target,
                UserName = user,
                CredentialBlobSize = bytes.Length,
                CredentialBlob = blobPtr,
                Persist = 2 // CRED_PERSIST_LOCAL_MACHINE
            };

            bool ok = CredWrite(ref cred, 0);
            Marshal.FreeHGlobal(blobPtr);
            return ok ? 0 : 5;
        }

        return 1;
    }
}
