import koffi from 'koffi';

// Mirrors winnt.h. Koffi lays out SIZE_T/ULONG_PTR for the native architecture.
const basicLimits = koffi.struct({
  processTime: 'int64_t', jobTime: 'int64_t', flags: 'uint32_t',
  minSet: 'size_t', maxSet: 'size_t', activeLimit: 'uint32_t',
  affinity: 'uintptr_t', priority: 'uint32_t', scheduling: 'uint32_t',
});
const extendedLimits = koffi.struct({
  basic: basicLimits, ioCounters: koffi.array('uint64_t', 6),
  processMemory: 'size_t', jobMemory: 'size_t', peakProcess: 'size_t', peakJob: 'size_t',
});

// All handles stay inside the supervisor. No target exists until setup succeeds.
// Windows closes its handle on exit, including abnormal termination.
export function ownWindowsJob(): () => void {
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *, void *)');
  const set = kernel.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)');
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)');
  const self = kernel.func('void * __stdcall GetCurrentProcess()');
  const freeConsole = kernel.func('int __stdcall FreeConsole()');
  const allocConsole = kernel.func('int __stdcall AllocConsole()');
  const sendBreak = kernel.func('int __stdcall GenerateConsoleCtrlEvent(uint32_t, uint32_t)');

  const job = create(null, null);
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  limits.writeUInt32LE(0x2000, koffi.offsetof(basicLimits, 'flags')); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!job || !set(job, 9, limits, limits.length) || !assign(job, self())) {
    throw new Error('无法创建 Windows Job Object');
  }
  freeConsole();
  if (!allocConsole()) throw new Error('无法创建独立的 Windows 控制台');
  // AllocConsole resets the handler list installed earlier by Node/libuv.
  // Register after allocation so the supervisor survives its own broadcast.
  // This single registered callback must remain valid until this process exits.
  const handlerType = koffi.proto('int __stdcall ConcordiaControlHandler(uint32_t)');
  const setHandler = kernel.func('int __stdcall SetConsoleCtrlHandler(ConcordiaControlHandler *, int)');
  const handler = koffi.register((event: number) => Number(event === 1), koffi.pointer(handlerType));
  if (!setHandler(handler, 1)) throw new Error('无法安装 Windows 控制台退出处理程序');
  // The zero group identifier addresses only this new console.
  return () => { sendBreak(1, 0); };
}
