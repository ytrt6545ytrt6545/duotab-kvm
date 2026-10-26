using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public class ScreenCaptureBridge {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    public static byte[] CaptureJpeg(int width, int height, long quality = 75) {
        IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
        if (hDesk != IntPtr.Zero) {
            SetThreadDesktop(hDesk);
        }

        using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(0, 0, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }

            using (MemoryStream ms = new MemoryStream()) {
                ImageCodecInfo encoder = GetEncoder(ImageFormat.Jpeg);
                EncoderParameters encParams = new EncoderParameters(1);
                encParams.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                bmp.Save(ms, encoder, encParams);
                return ms.ToArray();
            }
        }
    }

    private static ImageCodecInfo GetEncoder(ImageFormat format) {
        ImageCodecInfo[] codecs = ImageCodecInfo.GetImageDecoders();
        foreach (ImageCodecInfo codec in codecs) {
            if (codec.FormatID == format.Guid) {
                return codec;
            }
        }
        return null;
    }

    public static void Main(string[] args) {
        if (args.Length > 0 && args[0].ToLower() == "stream") {
            int width = args.Length > 1 ? int.Parse(args[1]) : 1536;
            int height = args.Length > 2 ? int.Parse(args[2]) : 864;
            int fps = args.Length > 3 ? int.Parse(args[3]) : 30;
            int quality = args.Length > 4 ? int.Parse(args[4]) : 65;

            Stream stdout = Console.OpenStandardOutput();
            byte[] header = new byte[7];
            header[0] = (byte)'D';
            header[1] = (byte)'T';
            header[2] = 0x05; // JPEG 幀類型

            int intervalMs = Math.Max(10, 1000 / fps);

            while (true) {
                try {
                    byte[] jpeg = CaptureJpeg(width, height, quality);
                    if (jpeg != null && jpeg.Length > 0) {
                        int len = jpeg.Length;
                        header[3] = (byte)((len >> 24) & 0xFF);
                        header[4] = (byte)((len >> 16) & 0xFF);
                        header[5] = (byte)((len >> 8) & 0xFF);
                        header[6] = (byte)(len & 0xFF);

                        stdout.Write(header, 0, 7);
                        stdout.Write(jpeg, 0, len);
                        stdout.Flush();
                    }
                    System.Threading.Thread.Sleep(intervalMs);
                } catch {
                    break;
                }
            }
        } else {
            byte[] bytes = CaptureJpeg(1536, 864, 70);
            File.WriteAllBytes("screen_test.jpg", bytes);
            Console.WriteLine("SUCCESS:" + bytes.Length);
        }
    }
}
