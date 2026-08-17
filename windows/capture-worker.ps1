$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$captureSource = @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ProstarCapture
{
    public sealed class CaptureResult
    {
        public byte[] Buffer;
        public int Length;
        public int Width;
        public int Height;
    }

    internal static class NativeMethods
    {
        internal const int HALFTONE = 4;
        internal const uint SRCCOPY_CAPTUREBLT = 0x40CC0020;

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        internal static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("user32.dll")]
        internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

        [DllImport("gdi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool StretchBlt(
            IntPtr destination,
            int destinationX,
            int destinationY,
            int destinationWidth,
            int destinationHeight,
            IntPtr source,
            int sourceX,
            int sourceY,
            int sourceWidth,
            int sourceHeight,
            uint operation);

        [DllImport("gdi32.dll")]
        internal static extern int SetStretchBltMode(IntPtr dc, int mode);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetBrushOrgEx(
            IntPtr dc,
            int x,
            int y,
            IntPtr previousPoint);
    }

    public static class CaptureEngine
    {
        private static readonly object Gate = new object();
        private static readonly MemoryStream JpegStream = new MemoryStream(1024 * 1024);
        private static readonly ImageCodecInfo JpegCodec = FindJpegCodec();
        private static Bitmap targetBitmap;
        private static Graphics targetGraphics;

        public static CaptureResult Capture(
            int? displayId,
            double scale,
            int maxWidth,
            long jpegQuality,
            bool encode)
        {
            lock (Gate)
            {
                // Screen coordinates must be physical pixels when monitors use
                // different scaling factors. This is intentionally per-thread:
                // PowerShell may already have initialized process-wide DPI state.
                try
                {
                    NativeMethods.SetThreadDpiAwarenessContext(new IntPtr(-4));
                }
                catch (EntryPointNotFoundException)
                {
                    // Prostar targets Windows 10+, but retaining this fallback
                    // makes the worker fail gracefully on an older host.
                }

                Screen screen = SelectScreen(displayId);
                Rectangle bounds = screen.Bounds;
                int scaledWidth = Math.Max(1, (int)Math.Floor((bounds.Width * scale) + 0.5));
                int outputWidth = Math.Max(1, Math.Min(bounds.Width, Math.Min(scaledWidth, maxWidth)));
                int outputHeight = Math.Max(
                    1,
                    (int)Math.Floor(((double)bounds.Height * outputWidth / bounds.Width) + 0.5));

                EnsureTarget(outputWidth, outputHeight);
                CaptureIntoTarget(bounds, outputWidth, outputHeight);

                CaptureResult result = new CaptureResult();
                result.Width = outputWidth;
                result.Height = outputHeight;
                if (!encode)
                {
                    result.Buffer = new byte[0];
                    result.Length = 0;
                    return result;
                }

                JpegStream.Position = 0;
                JpegStream.SetLength(0);
                using (EncoderParameters parameters = new EncoderParameters(1))
                using (EncoderParameter quality = new EncoderParameter(Encoder.Quality, jpegQuality))
                {
                    parameters.Param[0] = quality;
                    targetBitmap.Save(JpegStream, JpegCodec, parameters);
                }
                result.Buffer = JpegStream.GetBuffer();
                result.Length = checked((int)JpegStream.Length);
                return result;
            }
        }

        public static void Close()
        {
            lock (Gate)
            {
                if (targetGraphics != null)
                {
                    targetGraphics.Dispose();
                    targetGraphics = null;
                }
                if (targetBitmap != null)
                {
                    targetBitmap.Dispose();
                    targetBitmap = null;
                }
                JpegStream.Dispose();
            }
        }

        private static Screen SelectScreen(int? displayId)
        {
            if (!displayId.HasValue)
            {
                Screen primary = Screen.PrimaryScreen;
                if (primary == null)
                {
                    throw new InvalidOperationException("No primary display is available");
                }
                return primary;
            }

            Screen[] screens = Screen.AllScreens;
            Array.Sort(screens, delegate(Screen left, Screen right)
            {
                if (left.Primary != right.Primary)
                {
                    return left.Primary ? -1 : 1;
                }
                return StringComparer.OrdinalIgnoreCase.Compare(left.DeviceName, right.DeviceName);
            });
            if (displayId.Value < 0 || displayId.Value >= screens.Length)
            {
                throw new ArgumentOutOfRangeException("displayId", "The selected display is unavailable");
            }
            return screens[displayId.Value];
        }

        private static void EnsureTarget(int width, int height)
        {
            if (targetBitmap != null && targetBitmap.Width == width && targetBitmap.Height == height)
            {
                return;
            }
            if (targetGraphics != null)
            {
                targetGraphics.Dispose();
            }
            if (targetBitmap != null)
            {
                targetBitmap.Dispose();
            }
            targetBitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            targetGraphics = Graphics.FromImage(targetBitmap);
        }

        private static void CaptureIntoTarget(Rectangle sourceBounds, int width, int height)
        {
            IntPtr sourceDc = NativeMethods.GetDC(IntPtr.Zero);
            if (sourceDc == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not access the interactive desktop");
            }

            IntPtr destinationDc = IntPtr.Zero;
            try
            {
                destinationDc = targetGraphics.GetHdc();
                NativeMethods.SetStretchBltMode(destinationDc, NativeMethods.HALFTONE);
                NativeMethods.SetBrushOrgEx(destinationDc, 0, 0, IntPtr.Zero);
                if (!NativeMethods.StretchBlt(
                    destinationDc,
                    0,
                    0,
                    width,
                    height,
                    sourceDc,
                    sourceBounds.X,
                    sourceBounds.Y,
                    sourceBounds.Width,
                    sourceBounds.Height,
                    NativeMethods.SRCCOPY_CAPTUREBLT))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not capture the display");
                }
            }
            finally
            {
                try
                {
                    if (destinationDc != IntPtr.Zero)
                    {
                        targetGraphics.ReleaseHdc(destinationDc);
                    }
                }
                finally
                {
                    NativeMethods.ReleaseDC(IntPtr.Zero, sourceDc);
                }
            }
        }

        private static ImageCodecInfo FindJpegCodec()
        {
            foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
            {
                if (String.Equals(codec.MimeType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
                {
                    return codec;
                }
            }
            throw new InvalidOperationException("The Windows JPEG encoder is unavailable");
        }
    }
}
'@

Add-Type -TypeDefinition $captureSource -ReferencedAssemblies @(
  "System.Drawing",
  "System.Windows.Forms"
)

$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$maximumHeaderLength = 65536

function Read-Exact([int]$length) {
  $buffer = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $count = $inputStream.Read($buffer, $offset, $length - $offset)
    if ($count -eq 0) {
      if ($offset -eq 0) { return $null }
      throw "The request ended in the middle of a frame."
    }
    $offset += $count
  }
  return ,$buffer
}

function Write-Response($header, [byte[]]$payload, [int]$payloadLength) {
  $json = ConvertTo-Json $header -Compress -Depth 4
  $encoded = $utf8.GetBytes($json)
  if ($encoded.Length -le 0 -or $encoded.Length -gt $maximumHeaderLength) {
    throw "The response header is invalid."
  }
  $prefix = [BitConverter]::GetBytes([uint32]$encoded.Length)
  $outputStream.Write($prefix, 0, $prefix.Length)
  $outputStream.Write($encoded, 0, $encoded.Length)
  if ($payloadLength -gt 0) {
    $outputStream.Write($payload, 0, $payloadLength)
  }
  $outputStream.Flush()
}

function Write-ErrorResponse([int]$id, [string]$code, [string]$message) {
  Write-Response @{
    v = 1
    id = $id
    ok = $false
    length = 0
    code = $code
    error = $message
  } ([byte[]]@()) 0
}

try {
  while ($true) {
    $prefix = Read-Exact 4
    if ($null -eq $prefix) { break }
    $headerLength = [BitConverter]::ToUInt32($prefix, 0)
    if ($headerLength -le 0 -or $headerLength -gt $maximumHeaderLength) {
      throw "The request header length is invalid."
    }
    $encodedRequest = Read-Exact ([int]$headerLength)
    if ($null -eq $encodedRequest) {
      throw "The request header is incomplete."
    }

    $requestId = 0
    try {
      $request = ConvertFrom-Json $utf8.GetString($encodedRequest)
      $requestId = [int]$request.id
      if ([int]$request.v -ne 1) { throw "Unsupported protocol version." }
      if ($requestId -le 0) { throw "The request id is invalid." }
      $operation = [string]$request.op
      if ($operation -ne "capture" -and $operation -ne "probe") {
        throw "The capture operation is invalid."
      }

      $quality = [int]$request.jpegQuality
      $scale = [double]$request.scale
      $maxWidth = [int]$request.maxWidth
      if ($quality -lt 1 -or $quality -gt 100) { throw "JPEG quality is invalid." }
      if ([double]::IsNaN($scale) -or [double]::IsInfinity($scale) -or $scale -le 0 -or $scale -gt 1) {
        throw "Capture scale is invalid."
      }
      if ($maxWidth -lt 1 -or $maxWidth -gt 7680) { throw "Maximum width is invalid." }

      $displayId = $null
      if ($request.PSObject.Properties.Name -contains "displayId") {
        $displayId = [int]$request.displayId
      }
      $result = [ProstarCapture.CaptureEngine]::Capture(
        $displayId,
        $scale,
        $maxWidth,
        [long]$quality,
        $operation -eq "capture"
      )
      Write-Response @{
        v = 1
        id = $requestId
        ok = $true
        length = $result.Length
        mime = $(if ($operation -eq "capture") { "image/jpeg" } else { "" })
        width = $result.Width
        height = $result.Height
      } $result.Buffer $result.Length
    }
    catch {
      $exception = $_.Exception
      while ($null -ne $exception.InnerException) {
        $exception = $exception.InnerException
      }
      $code = "capture_failed"
      if ($exception -is [System.ArgumentOutOfRangeException]) {
        $code = "invalid_display"
      }
      elseif ($exception -is [System.ArgumentException] -or $exception -is [System.FormatException]) {
        $code = "invalid_request"
      }
      Write-ErrorResponse $requestId $code $exception.Message
    }
  }
}
finally {
  [ProstarCapture.CaptureEngine]::Close()
  $inputStream.Dispose()
  $outputStream.Dispose()
}
