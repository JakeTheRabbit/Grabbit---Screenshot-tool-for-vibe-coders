using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Rect32 = System.Drawing.Rectangle;

namespace Grabbit;

/// <summary>
/// The desktop rectangles of the default adapter's outputs, in DXGI order. ffmpeg's ddagrab picks a monitor by
/// that index (<c>output_idx</c>), which matches neither Screen.AllScreens nor the DISPLAYn numbers.
/// </summary>
internal static class Dxgi
{
    public static List<Rect32> Outputs()
    {
        var list = new List<Rect32>();
        var iid = typeof(IDXGIFactory).GUID;
        if (CreateDXGIFactory1(ref iid, out var factory) < 0) return list;
        try
        {
            if (factory.EnumAdapters(0, out var adapter) < 0) return list;
            try
            {
                for (uint i = 0; adapter.EnumOutputs(i, out var output) >= 0; i++)
                {
                    output.GetDesc(out var d);
                    list.Add(Rect32.FromLTRB(d.Left, d.Top, d.Right, d.Bottom));
                    Marshal.ReleaseComObject(output);
                }
            }
            finally { Marshal.ReleaseComObject(adapter); }
        }
        finally { Marshal.ReleaseComObject(factory); }
        return list;
    }

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory factory);

    // Vtables declared in order up to the one method used; the placeholders are never called.
    [ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter adapter);
    }

    [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
    }

    [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIOutput
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        [PreserveSig] int GetDesc(out OutputDesc desc);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OutputDesc
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public int Left, Top, Right, Bottom;
        public int AttachedToDesktop, Rotation;
        public IntPtr Monitor;
    }
}
