using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace Grabbit;

/// <summary>Encoded image ready for the clipboard: the pixels it was made from plus the file bytes.</summary>
public sealed record Encoded(Bitmap Pixels, byte[] Bytes, string Extension)
{
    public string Describe() => $"{Pixels.Width} × {Pixels.Height} {Extension.TrimStart('.').ToUpperInvariant()} ({Bytes.Length / 1024.0 / 1024.0:0.0} MB)";
}

public static class ImageExport
{
    public static Encoded Encode(Bitmap source, CopySize size, AppSettings s) => size switch
    {
        CopySize.Full => new(source, Png(source), ".png"),
        CopySize.Reduced => Reduced(source, s.ReducedLongEdge),
        _ => Chat(source, s.ChatLongEdge, s.ChatMaxKB * 1024L),
    };

    static Encoded Reduced(Bitmap source, int longEdge)
    {
        var small = Fit(source, longEdge);
        return new(small, Png(small), ".png");
    }

    /// <summary>JPEG that fits under <paramref name="maxBytes"/>: drop quality to 60 first, then shrink 15 % at a time.</summary>
    static Encoded Chat(Bitmap source, int longEdge, long maxBytes)
    {
        var img = Fit(source, longEdge);
        while (true)
        {
            int lo = 60, hi = 90;
            byte[]? best = null;
            while (lo <= hi)   // highest quality that still fits
            {
                var q = (lo + hi) / 2;
                var bytes = Jpeg(img, q);
                if (bytes.Length <= maxBytes) { best = bytes; lo = q + 1; } else hi = q - 1;
            }
            if (best != null || Math.Max(img.Width, img.Height) < 400) return new(img, best ?? Jpeg(img, 60), ".jpg");
            var smaller = Fit(img, (int)(Math.Max(img.Width, img.Height) * 0.85));
            if (!ReferenceEquals(img, source)) img.Dispose();
            img = smaller;
        }
    }

    /// <summary>High-quality downscale so the long edge is at most <paramref name="longEdge"/>; returns the source itself if already small enough.</summary>
    public static Bitmap Fit(Bitmap source, int longEdge)
    {
        var scale = (double)longEdge / Math.Max(source.Width, source.Height);
        if (scale >= 1) return source;
        int w = Math.Max(1, (int)Math.Round(source.Width * scale)), h = Math.Max(1, (int)Math.Round(source.Height * scale));
        var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(dst);
        g.CompositingMode = CompositingMode.SourceCopy;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        using var wrap = new ImageAttributes();
        wrap.SetWrapMode(WrapMode.TileFlipXY);   // no dark fringe on the edges
        g.DrawImage(source, new Rectangle(0, 0, w, h), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, wrap);
        return dst;
    }

    /// <summary>GDI+ bitmap into WPF (BMP in memory: the fastest lossless round trip). Frozen, 96 DPI.</summary>
    public static System.Windows.Media.Imaging.BitmapSource ToSource(Bitmap bmp)
    {
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Bmp);
        ms.Position = 0;
        var img = new System.Windows.Media.Imaging.BitmapImage();
        img.BeginInit();
        img.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
        img.StreamSource = ms;
        img.EndInit();
        img.Freeze();
        return img;
    }

    /// <summary>WebP's hard limit per side; taller scroll captures are kept as PNG.</summary>
    public const int WebpMaxSide = 16383;

    /// <summary>
    /// Lossless WebP through libwebp's dedicated lossless entry point (WebPEncodeLosslessBGRA), which cannot produce a
    /// lossy file. Measured on a real 4K capture: ~42 % of PNG's size, pixel-exact. (Imazen's config-based encoder was
    /// tried first and silently came out lossy, so it isn't used.)
    /// </summary>
    public static byte[] WebpLossless(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var output = IntPtr.Zero;
        try
        {
            var size = (long)Imazen.WebP.Extern.NativeMethods.WebPEncodeLosslessBGRA(data.Scan0, bmp.Width, bmp.Height, data.Stride, ref output);
            if (size == 0 || output == IntPtr.Zero) throw new InvalidOperationException("libwebp could not encode this picture.");
            var bytes = new byte[size];
            Marshal.Copy(output, bytes, 0, bytes.Length);
            return bytes;
        }
        finally
        {
            if (output != IntPtr.Zero) Imazen.WebP.Extern.NativeMethods.WebPFree(output);
            bmp.UnlockBits(data);
        }
    }

    static bool IsWebp(byte[] b) => b.Length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P';

    /// <summary>Any image Grabbit saves (WebP, PNG, JPEG) into a GDI+ bitmap; GDI+ itself can't read WebP. Caller owns it.</summary>
    public static Bitmap Decode(byte[] bytes)
    {
        if (IsWebp(bytes)) return new Imazen.WebP.SimpleDecoder().DecodeFromBytes(bytes, bytes.Length);
        using var decoded = new Bitmap(new MemoryStream(bytes));
        return new Bitmap(decoded);   // detach from the stream
    }

    /// <summary>Pixel size without decoding the whole image.</summary>
    public static (int Width, int Height) Measure(byte[] bytes)
    {
        if (IsWebp(bytes))
        {
            var h = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            int w = 0, ht = 0;
            try { return Imazen.WebP.Extern.NativeMethods.WebPGetInfo(h.AddrOfPinnedObject(), (UIntPtr)bytes.Length, ref w, ref ht) != 0 ? (w, ht) : (0, 0); }
            finally { h.Free(); }
        }
        using var img = System.Drawing.Image.FromStream(new MemoryStream(bytes), false, false);
        return (img.Width, img.Height);
    }

    /// <summary>
    /// Save losslessly in the smallest sensible format: WebP lossless (or PNG if the setting says so, or if a side is over
    /// WebP's 16 383 px limit). <paramref name="pathWithoutExtension"/> gets the right extension; returns the full path.
    /// </summary>
    public static string SaveLossless(Bitmap bmp, string pathWithoutExtension, SaveFormat format)
    {
        var webp = format == SaveFormat.WebpLossless && bmp.Width <= WebpMaxSide && bmp.Height <= WebpMaxSide;
        var path = pathWithoutExtension + (webp ? ".webp" : ".png");
        File.WriteAllBytes(path, webp ? WebpLossless(bmp) : Png(bmp));
        return path;
    }

    public static byte[] Png(Bitmap bmp)
    {
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    public static byte[] Jpeg(Bitmap bmp, long quality)
    {
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var p = new EncoderParameters(1);
        p.Param[0] = new EncoderParameter(Encoder.Quality, quality);
        using var ms = new MemoryStream();
        bmp.Save(ms, codec, p);
        return ms.ToArray();
    }

    /// <summary>CF_DIBV5: 32-bit BGRA with alpha masks, bottom-up. Keeps transparency in Word/PowerPoint.</summary>
    public static byte[] DibV5(Bitmap bmp)
    {
        const int header = 124;
        var pixels = Pixels(bmp, PixelFormat.Format32bppArgb, out var stride);
        var buf = new byte[header + pixels.Length];
        using (var w = new BinaryWriter(new MemoryStream(buf)))
        {
            w.Write(header); w.Write(bmp.Width); w.Write(bmp.Height);   // positive height = bottom-up
            w.Write((short)1); w.Write((short)32);
            w.Write(3);                                   // BI_BITFIELDS
            w.Write(pixels.Length); w.Write(2835); w.Write(2835); w.Write(0); w.Write(0);
            w.Write(0x00FF0000); w.Write(0x0000FF00); w.Write(0x000000FF); w.Write(unchecked((int)0xFF000000));
            w.Write(0x73524742);                          // LCS_sRGB
            // endpoints (36 bytes), gamma (12), intent, profile data, profile size, reserved
            w.Write(new byte[36 + 12]); w.Write(4 /* LCS_GM_IMAGES */); w.Write(0); w.Write(0); w.Write(0);
        }
        CopyBottomUp(pixels, stride, bmp.Height, buf, header);
        return buf;
    }

    /// <summary>CF_DIB: 24-bit, bottom-up. The lowest common denominator (Paint, old apps).</summary>
    public static byte[] Dib(Bitmap bmp)
    {
        const int header = 40;
        var pixels = Pixels(bmp, PixelFormat.Format24bppRgb, out var stride);
        var buf = new byte[header + pixels.Length];
        using (var w = new BinaryWriter(new MemoryStream(buf)))
        {
            w.Write(header); w.Write(bmp.Width); w.Write(bmp.Height);
            w.Write((short)1); w.Write((short)24); w.Write(0 /* BI_RGB */);
            w.Write(pixels.Length); w.Write(2835); w.Write(2835); w.Write(0); w.Write(0);
        }
        CopyBottomUp(pixels, stride, bmp.Height, buf, header);
        return buf;
    }

    static byte[] Pixels(Bitmap bmp, PixelFormat format, out int stride)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, format);
        try
        {
            stride = data.Stride;   // GDI+ strides are DWORD-aligned, same rule as DIB rows
            var bytes = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            return bytes;
        }
        finally { bmp.UnlockBits(data); }
    }

    static void CopyBottomUp(byte[] topDown, int stride, int height, byte[] dest, int offset)
    {
        for (var y = 0; y < height; y++)
            Buffer.BlockCopy(topDown, y * stride, dest, offset + (height - 1 - y) * stride, stride);
    }
}
