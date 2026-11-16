#![no_std]
#![allow(non_camel_case_types, non_snake_case)]

use core::ffi::c_void;
use core::panic::PanicInfo;
use core::ptr::{copy_nonoverlapping, null_mut, write_bytes, write_volatile};
use core::sync::atomic::{AtomicUsize, Ordering};

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

type HANDLE = *mut c_void;
type HMODULE = *mut c_void;
type BOOL = i32;
type DWORD = u32;
type LPWSTR = *mut u16;
type LPCWSTR = *const u16;
type LPCSTR = *const u8;
type LPBYTE = *mut u8;

const CP_UTF8: u32 = 65001;
const CRED_TYPE_GENERIC: u32 = 1;
const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;

#[repr(C)]
struct FILETIME {
    dw_low_date_time: DWORD,
    dw_high_date_time: DWORD,
}

#[repr(C)]
struct CREDENTIALW {
    flags: DWORD,
    cred_type: DWORD,
    target_name: LPWSTR,
    comment: LPWSTR,
    last_written: FILETIME,
    credential_blob_size: DWORD,
    credential_blob: LPBYTE,
    persist: DWORD,
    attribute_count: DWORD,
    attributes: *mut c_void,
    target_alias: LPWSTR,
    user_name: LPWSTR,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetProcessHeap() -> HANDLE;
    fn HeapAlloc(h_heap: HANDLE, dw_flags: DWORD, dw_bytes: usize) -> *mut c_void;
    fn HeapFree(h_heap: HANDLE, dw_flags: DWORD, lp_mem: *mut c_void) -> BOOL;
    fn GetModuleHandleW(lp_module_name: LPCWSTR) -> HMODULE;
    fn GetProcAddress(h_module: HMODULE, lp_proc_name: LPCSTR) -> *const c_void;
    fn GetCurrentProcess() -> HANDLE;
    fn K32EnumProcessModules(
        h_process: HANDLE,
        lph_module: *mut HMODULE,
        cb: DWORD,
        lpcb_needed: *mut DWORD,
    ) -> BOOL;
    fn MultiByteToWideChar(
        code_page: u32,
        dw_flags: DWORD,
        lp_multi_byte_str: *const u8,
        cb_multi_byte: i32,
        lp_wide_char_str: LPWSTR,
        cch_wide_char: i32,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn CredReadW(
        target_name: LPCWSTR,
        cred_type: DWORD,
        flags: DWORD,
        credential: *mut *mut CREDENTIALW,
    ) -> BOOL;
    fn CredWriteW(user_credential: *mut CREDENTIALW, flags: DWORD) -> BOOL;
    fn CredDeleteW(target_name: LPCWSTR, cred_type: DWORD, flags: DWORD) -> BOOL;
    fn CredFree(buffer: *mut c_void);
}

#[no_mangle]
pub unsafe extern "system" fn _DllMainCRTStartup(
    _hinst_dll: HMODULE,
    _fdw_reason: DWORD,
    _lpv_reserved: *mut c_void,
) -> BOOL {
    1
}

#[no_mangle]
pub unsafe extern "C" fn memcpy(dest: *mut u8, src: *const u8, n: usize) -> *mut u8 {
    copy_nonoverlapping(src, dest, n);
    dest
}

#[no_mangle]
pub unsafe extern "C" fn memset(s: *mut u8, c: i32, n: usize) -> *mut u8 {
    write_bytes(s, c as u8, n);
    s
}

#[no_mangle]
pub unsafe extern "C" fn memcmp(s1: *const u8, s2: *const u8, n: usize) -> i32 {
    let mut i = 0;
    while i < n {
        let a = *s1.add(i);
        let b = *s2.add(i);
        if a != b {
            return (a as i32) - (b as i32);
        }
        i += 1;
    }
    0
}

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiCallbackInfo = *mut c_void;
type NapiStatus = i32;
type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

const NAPI_OK: NapiStatus = 0;

#[repr(C)]
struct NapiPropertyDescriptor {
    utf8name: *const u8,
    name: NapiValue,
    method: Option<NapiCallback>,
    getter: Option<NapiCallback>,
    setter: Option<NapiCallback>,
    value: NapiValue,
    attributes: u32,
    data: *mut c_void,
}

type FnNapiDefineProperties =
    unsafe extern "C" fn(NapiEnv, NapiValue, usize, *const NapiPropertyDescriptor) -> NapiStatus;
type FnNapiGetCbInfo = unsafe extern "C" fn(
    NapiEnv,
    NapiCallbackInfo,
    *mut usize,
    *mut NapiValue,
    *mut NapiValue,
    *mut *mut c_void,
) -> NapiStatus;
type FnNapiGetValueStringUtf8 =
    unsafe extern "C" fn(NapiEnv, NapiValue, *mut u8, usize, *mut usize) -> NapiStatus;
type FnNapiCreateStringUtf8 =
    unsafe extern "C" fn(NapiEnv, *const u8, usize, *mut NapiValue) -> NapiStatus;
type FnNapiGetBoolean = unsafe extern "C" fn(NapiEnv, u8, *mut NapiValue) -> NapiStatus;
type FnNapiGetNull = unsafe extern "C" fn(NapiEnv, *mut NapiValue) -> NapiStatus;
type FnNapiThrowError = unsafe extern "C" fn(NapiEnv, *const u8, *const u8) -> NapiStatus;

struct NapiTable {
    define_properties: AtomicUsize,
    get_cb_info: AtomicUsize,
    get_value_string_utf8: AtomicUsize,
    create_string_utf8: AtomicUsize,
    get_boolean: AtomicUsize,
    get_null: AtomicUsize,
    throw_error: AtomicUsize,
}

static NAPI: NapiTable = NapiTable {
    define_properties: AtomicUsize::new(0),
    get_cb_info: AtomicUsize::new(0),
    get_value_string_utf8: AtomicUsize::new(0),
    create_string_utf8: AtomicUsize::new(0),
    get_boolean: AtomicUsize::new(0),
    get_null: AtomicUsize::new(0),
    throw_error: AtomicUsize::new(0),
};

unsafe fn find_napi_host_module() -> HMODULE {
    let exe = GetModuleHandleW(null_mut());
    if !exe.is_null()
        && !GetProcAddress(exe, b"napi_create_string_utf8\0".as_ptr()).is_null()
    {
        return exe;
    }

    const NODE_DLL: [u16; 9] = [b'n' as u16, b'o' as u16, b'd' as u16, b'e' as u16, b'.' as u16, b'd' as u16, b'l' as u16, b'l' as u16, 0];
    let nd = GetModuleHandleW(NODE_DLL.as_ptr());
    if !nd.is_null()
        && !GetProcAddress(nd, b"napi_create_string_utf8\0".as_ptr()).is_null()
    {
        return nd;
    }

    let mut mods: [HMODULE; 512] = [null_mut(); 512];
    let mut needed: DWORD = 0;
    if K32EnumProcessModules(
        GetCurrentProcess(),
        mods.as_mut_ptr(),
        core::mem::size_of::<[HMODULE; 512]>() as DWORD,
        &mut needed,
    ) != 0
    {
        let count = core::cmp::min(
            (needed as usize) / core::mem::size_of::<HMODULE>(),
            mods.len(),
        );
        let mut i = 0;
        while i < count {
            let m = mods[i];
            if !m.is_null()
                && !GetProcAddress(m, b"napi_create_string_utf8\0".as_ptr()).is_null()
            {
                return m;
            }
            i += 1;
        }
    }
    null_mut()
}

unsafe fn ensure_napi_resolved() -> bool {
    if NAPI.create_string_utf8.load(Ordering::Acquire) != 0 {
        return true;
    }
    let h = find_napi_host_module();
    if h.is_null() {
        return false;
    }

    let syms: [(&AtomicUsize, &[u8]); 7] = [
        (&NAPI.define_properties, b"napi_define_properties\0"),
        (&NAPI.get_cb_info, b"napi_get_cb_info\0"),
        (&NAPI.get_value_string_utf8, b"napi_get_value_string_utf8\0"),
        (&NAPI.create_string_utf8, b"napi_create_string_utf8\0"),
        (&NAPI.get_boolean, b"napi_get_boolean\0"),
        (&NAPI.get_null, b"napi_get_null\0"),
        (&NAPI.throw_error, b"napi_throw_error\0"),
    ];

    for (slot, name) in syms.iter() {
        let addr = GetProcAddress(h, name.as_ptr()) as usize;
        if addr == 0 {
            return false;
        }
        slot.store(addr, Ordering::Release);
    }
    true
}

#[inline(always)]
unsafe fn fn_define_properties() -> FnNapiDefineProperties {
    core::mem::transmute(NAPI.define_properties.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_get_cb_info() -> FnNapiGetCbInfo {
    core::mem::transmute(NAPI.get_cb_info.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_get_value_string_utf8() -> FnNapiGetValueStringUtf8 {
    core::mem::transmute(NAPI.get_value_string_utf8.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_create_string_utf8() -> FnNapiCreateStringUtf8 {
    core::mem::transmute(NAPI.create_string_utf8.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_get_boolean() -> FnNapiGetBoolean {
    core::mem::transmute(NAPI.get_boolean.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_get_null() -> FnNapiGetNull {
    core::mem::transmute(NAPI.get_null.load(Ordering::Acquire))
}
#[inline(always)]
unsafe fn fn_throw_error() -> FnNapiThrowError {
    core::mem::transmute(NAPI.throw_error.load(Ordering::Acquire))
}

struct HeapBuf {
    ptr: *mut u8,
    cap: usize,
    len: usize,
    wipe: bool,
}

impl HeapBuf {
    unsafe fn alloc(size: usize, wipe: bool) -> Option<Self> {
        let alloc_size = if size == 0 { 1 } else { size };
        let mem = HeapAlloc(GetProcessHeap(), 0, alloc_size) as *mut u8;
        if mem.is_null() {
            return None;
        }
        Some(Self {
            ptr: mem,
            cap: alloc_size,
            len: 0,
            wipe,
        })
    }
}

impl Drop for HeapBuf {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe {
                if self.wipe {
                    let mut i = 0;
                    while i < self.cap {
                        write_volatile(self.ptr.add(i), 0);
                        i += 1;
                    }
                }
                HeapFree(GetProcessHeap(), 0, self.ptr as *mut c_void);
            }
            self.ptr = null_mut();
        }
    }
}

unsafe fn extract_utf8_arg(env: NapiEnv, val: NapiValue, wipe: bool) -> Option<HeapBuf> {
    let get_str = fn_get_value_string_utf8();
    let mut byte_len: usize = 0;
    if get_str(env, val, null_mut(), 0, &mut byte_len) != NAPI_OK {
        return None;
    }
    let mut buf = HeapBuf::alloc(byte_len + 1, wipe)?;
    let mut copied: usize = 0;
    if get_str(env, val, buf.ptr, byte_len + 1, &mut copied) != NAPI_OK {
        return None;
    }
    buf.len = copied;
    Some(buf)
}

unsafe fn utf8_to_wide_nul(utf8: &HeapBuf) -> Option<HeapBuf> {
    if utf8.len == 0 {
        let mut wbuf = HeapBuf::alloc(2, false)?;
        *(wbuf.ptr as *mut u16) = 0;
        wbuf.len = 1;
        return Some(wbuf);
    }
    if utf8.len > i32::MAX as usize {
        return None;
    }
    let wchars = MultiByteToWideChar(
        CP_UTF8,
        0,
        utf8.ptr,
        utf8.len as i32,
        null_mut(),
        0,
    );
    if wchars <= 0 {
        return None;
    }
    let mut wbuf = HeapBuf::alloc(((wchars as usize) + 1) * 2, false)?;
    let written = MultiByteToWideChar(
        CP_UTF8,
        0,
        utf8.ptr,
        utf8.len as i32,
        wbuf.ptr as LPWSTR,
        wchars,
    );
    if written <= 0 {
        return None;
    }
    *((wbuf.ptr as LPWSTR).add(written as usize)) = 0;
    wbuf.len = (written as usize) + 1;
    Some(wbuf)
}

unsafe fn make_null(env: NapiEnv) -> NapiValue {
    let mut out: NapiValue = null_mut();
    fn_get_null()(env, &mut out);
    out
}

unsafe fn make_bool(env: NapiEnv, val: bool) -> NapiValue {
    let mut out: NapiValue = null_mut();
    fn_get_boolean()(env, if val { 1 } else { 0 }, &mut out);
    out
}

unsafe extern "C" fn js_read_credential(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc: usize = 1;
    let mut argv: [NapiValue; 1] = [null_mut()];
    if fn_get_cb_info()(env, info, &mut argc, argv.as_mut_ptr(), null_mut(), null_mut()) != NAPI_OK
        || argc < 1
    {
        fn_throw_error()(env, b"EINVAL\0".as_ptr(), b"targetName string required\0".as_ptr());
        return null_mut();
    }

    let target_utf8 = match extract_utf8_arg(env, argv[0], false) {
        Some(v) => v,
        None => return make_null(env),
    };
    let target_w = match utf8_to_wide_nul(&target_utf8) {
        Some(v) => v,
        None => return make_null(env),
    };

    let mut cred_ptr: *mut CREDENTIALW = null_mut();
    let ok = CredReadW(target_w.ptr as LPCWSTR, CRED_TYPE_GENERIC, 0, &mut cred_ptr);
    if ok == 0 || cred_ptr.is_null() {
        return make_null(env);
    }

    let mut out: NapiValue = null_mut();
    let blob = (*cred_ptr).credential_blob;
    let size = (*cred_ptr).credential_blob_size as usize;
    if !blob.is_null() && size > 0 {
        if fn_create_string_utf8()(env, blob, size, &mut out) != NAPI_OK {
            out = make_null(env);
        }
    } else {
        out = make_null(env);
    }
    CredFree(cred_ptr as *mut c_void);
    out
}

unsafe extern "C" fn js_write_credential(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc: usize = 3;
    let mut argv: [NapiValue; 3] = [null_mut(); 3];
    if fn_get_cb_info()(env, info, &mut argc, argv.as_mut_ptr(), null_mut(), null_mut()) != NAPI_OK
        || argc < 3
    {
        fn_throw_error()(
            env,
            b"EINVAL\0".as_ptr(),
            b"targetName, userName, secretUtf8 required\0".as_ptr(),
        );
        return null_mut();
    }

    let target_utf8 = match extract_utf8_arg(env, argv[0], false) {
        Some(v) => v,
        None => return make_bool(env, false),
    };
    let user_utf8 = match extract_utf8_arg(env, argv[1], false) {
        Some(v) => v,
        None => return make_bool(env, false),
    };
    let secret_utf8 = match extract_utf8_arg(env, argv[2], true) {
        Some(v) => v,
        None => return make_bool(env, false),
    };
    if secret_utf8.len > u32::MAX as usize {
        return make_bool(env, false);
    }

    let target_w = match utf8_to_wide_nul(&target_utf8) {
        Some(v) => v,
        None => return make_bool(env, false),
    };
    let user_w = match utf8_to_wide_nul(&user_utf8) {
        Some(v) => v,
        None => return make_bool(env, false),
    };

    let mut cred = CREDENTIALW {
        flags: 0,
        cred_type: CRED_TYPE_GENERIC,
        target_name: target_w.ptr as LPWSTR,
        comment: null_mut(),
        last_written: FILETIME {
            dw_low_date_time: 0,
            dw_high_date_time: 0,
        },
        credential_blob_size: secret_utf8.len as DWORD,
        credential_blob: if secret_utf8.len == 0 {
            null_mut()
        } else {
            secret_utf8.ptr
        },
        persist: CRED_PERSIST_LOCAL_MACHINE,
        attribute_count: 0,
        attributes: null_mut(),
        target_alias: null_mut(),
        user_name: user_w.ptr as LPWSTR,
    };

    let ok = CredWriteW(&mut cred, 0);
    make_bool(env, ok != 0)
}

unsafe extern "C" fn js_delete_credential(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc: usize = 1;
    let mut argv: [NapiValue; 1] = [null_mut()];
    if fn_get_cb_info()(env, info, &mut argc, argv.as_mut_ptr(), null_mut(), null_mut()) != NAPI_OK
        || argc < 1
    {
        fn_throw_error()(env, b"EINVAL\0".as_ptr(), b"targetName string required\0".as_ptr());
        return null_mut();
    }

    let target_utf8 = match extract_utf8_arg(env, argv[0], false) {
        Some(v) => v,
        None => return make_bool(env, false),
    };
    let target_w = match utf8_to_wide_nul(&target_utf8) {
        Some(v) => v,
        None => return make_bool(env, false),
    };

    let ok = CredDeleteW(target_w.ptr as LPCWSTR, CRED_TYPE_GENERIC, 0);
    make_bool(env, ok != 0)
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(
    env: NapiEnv,
    exports: NapiValue,
) -> NapiValue {
    if !ensure_napi_resolved() {
        return null_mut();
    }

    let props = [
        NapiPropertyDescriptor {
            utf8name: b"readCredential\0".as_ptr(),
            name: null_mut(),
            method: Some(js_read_credential),
            getter: None,
            setter: None,
            value: null_mut(),
            attributes: 0,
            data: null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: b"writeCredential\0".as_ptr(),
            name: null_mut(),
            method: Some(js_write_credential),
            getter: None,
            setter: None,
            value: null_mut(),
            attributes: 0,
            data: null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: b"deleteCredential\0".as_ptr(),
            name: null_mut(),
            method: Some(js_delete_credential),
            getter: None,
            setter: None,
            value: null_mut(),
            attributes: 0,
            data: null_mut(),
        },
    ];

    if fn_define_properties()(env, exports, props.len(), props.as_ptr()) != NAPI_OK {
        return null_mut();
    }
    exports
}
