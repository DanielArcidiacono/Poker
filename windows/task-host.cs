using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Prostar
{
    internal static class TaskHost
    {
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNoWindow = 0x08000000;
        private const uint Infinite = 0xffffffff;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int ExtendedLimitInformationClass = 9;
        private const uint WaitObject0 = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfo
        {
            public uint Size;
            public IntPtr Reserved;
            public IntPtr Desktop;
            public IntPtr Title;
            public uint X;
            public uint Y;
            public uint XSize;
            public uint YSize;
            public uint XCountChars;
            public uint YCountChars;
            public uint FillAttribute;
            public uint Flags;
            public ushort ShowWindow;
            public ushort Reserved2;
            public IntPtr Reserved2Pointer;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static bool ConfigureKillOnClose(IntPtr job)
        {
            JobObjectExtendedLimitInformation limits =
                new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;

            int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                return SetInformationJobObject(
                    job,
                    ExtendedLimitInformationClass,
                    buffer,
                    (uint)size
                );
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        [STAThread]
        private static int Main()
        {
            IntPtr job = IntPtr.Zero;
            ProcessInformation child = new ProcessInformation();
            bool childCreated = false;
            bool childCompleted = false;

            try
            {
                string localAppData = Environment.GetFolderPath(
                    Environment.SpecialFolder.LocalApplicationData
                );
                string appRoot = Path.GetFullPath(Path.Combine(localAppData, "Prostar"));
                string launcher = Path.Combine(appRoot, "prostar-launcher.cmd");
                if (!File.Exists(launcher))
                {
                    return 2;
                }

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero || !ConfigureKillOnClose(job))
                {
                    return 3;
                }

                string command = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                StringBuilder commandLine = new StringBuilder(
                    "\"" + command + "\" /d /q /c call \"" + launcher + "\""
                );
                StartupInfo startup = new StartupInfo();
                startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));

                if (!CreateProcess(
                    command,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateSuspended | CreateNoWindow,
                    IntPtr.Zero,
                    appRoot,
                    ref startup,
                    out child
                ))
                {
                    return 4;
                }
                childCreated = true;

                // The launcher is suspended until it belongs to this job. This
                // prevents Node or cloudflared from escaping if the host is
                // closed, crashes, or is terminated by Task Scheduler.
                if (!AssignProcessToJobObject(job, child.Process))
                {
                    return 5;
                }
                if (ResumeThread(child.Thread) == 0xffffffff)
                {
                    return 6;
                }
                CloseHandle(child.Thread);
                child.Thread = IntPtr.Zero;

                if (WaitForSingleObject(child.Process, Infinite) != WaitObject0)
                {
                    return 7;
                }
                childCompleted = true;

                uint exitCode;
                if (!GetExitCodeProcess(child.Process, out exitCode))
                {
                    return 8;
                }
                return unchecked((int)exitCode);
            }
            catch
            {
                return 1;
            }
            finally
            {
                if (childCreated && !childCompleted && child.Process != IntPtr.Zero)
                {
                    TerminateProcess(child.Process, 1);
                }
                if (child.Thread != IntPtr.Zero)
                {
                    CloseHandle(child.Thread);
                }
                if (child.Process != IntPtr.Zero)
                {
                    CloseHandle(child.Process);
                }
                // Closing the job is the fail-safe that terminates the entire
                // cmd -> Node -> cloudflared/capture-worker process tree.
                if (job != IntPtr.Zero)
                {
                    CloseHandle(job);
                }
            }
        }
    }
}
