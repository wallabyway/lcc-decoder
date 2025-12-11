# LCC 3D Gaussian Splatting Viewer

A minimal Three.js-based viewer for rendering LCC (Lixel CyberColor) format 3D Gaussian Splatting data.

## Features

- ✅ **LCC Format Support** - Loads and decodes LCC data files (meta.lcc, Data.bin, Index.bin)
- ✅ **Three.js Integration** - Custom shader material for gaussian splat rendering
- ✅ **Depth Sorting** - Web Worker-based depth sorting for proper transparency

## File Structure

```
root/
├── index.html          # minimal Three js viewer
├── lcc-loader.js       # LCC format decoder
├── splat-renderer.js   # Three.js gaussian splat renderer
└── README.md          # This file
```

## Usage

1. **Start a local web server:**
   ```bash
   python3 -m http.server 8000
   ```

2. **Open in browser:**
   ```
   http://localhost:8000/
   ```

3. **Load remote LCC data:**

   Showroom Sample: https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc

   Add a `?data=` parameter with the URL to the LCC file or directory:
   ```
http://localhost:8000/?data=https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc
   ```

## Demo:

https://lcc-viewer.xgrids.com/?data=https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc

## LCC Data Format

- See the spec/lcc-spec.pdf file for complete details

- The viewer expects LCC data in the following structure:

```
data-folder/
├── meta.lcc       # JSON metadata (splat count, bounding box, attributes)
├── Index.bin      # LOD index data
├── Data.bin       # Splat data (32 bytes per splat)
└── Shcoef.bin     # Spherical harmonics (optional, for Quality mode)
```

### Data.bin Structure (32 bytes per splat)

| Attribute | Bytes  | Type             | Description |
|-----------|--------|------------------|-------------|
| Position  | 0-11   | 3× float32       | XYZ position |
| Color     | 12-15  | uint32 RGBA      | Color + opacity |
| Scale     | 16-21  | 3× uint16        | XYZ scale (compressed) |
| Rotation  | 22-25  | uint32           | Quaternion (compressed) |
| Normal    | 26-31  | 3× uint16        | XYZ normal (optional) |

## Configuration

### LOD Level

In `index.html`, adjust the Level of Detail to load:

```javascript
const loader = new LCCLoader({ targetLOD: 4 }); // 0-6
```

**Available LOD levels** (from sample data):
- **Level 0**: 23.57M splats (highest detail, slowest)
- **Level 4**: 1.45M splats (good balance) ⭐ **Recommended**
- **Level 5**: 0.72M splats (lower detail)
- **Level 6**: 0.35M splats (lowest detail, fastest)

Lower LOD numbers = more detail but slower performance.


## Implementation Details

### Coordinate System

LCC format uses **Z-up coordinates** while Three.js uses **Y-up coordinates**. The viewer handles this during the loading process (3 line code changes):

### LCC Decoder (`lcc-loader.js`)

```javascript
 // Position: bytes 0-11 (3x float32)
            positions[i * 3 + 0] = view.getFloat32(offset + 0, true);
            positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
            positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
```

```javascript
// Becomes this:
//
// Rotate -90° around X: Z-up → Y-up (LCC to Three.js coordinate system)
            positions[i * 3 + 0] = view.getFloat32(offset + 0, true);   // X stays X
            positions[i * 3 + 1] = view.getFloat32(offset + 8, true);   // Z becomes Y
            positions[i * 3 + 2] = -view.getFloat32(offset + 4, true);  // Y becomes -Z
```


- Reads meta.lcc for scene metadata
- Parses Data.bin with proper byte offsets
- Decodes compressed rotation quaternions using lookup table
- Interpolates scales using min/max from metadata
- Computes 3D covariance matrices from scale + rotation

### Renderer (`splat-renderer.js`)

- Adapted from [kishimisu/Gaussian-Splatting-WebGL](https://github.com/kishimisu/Gaussian-Splatting-WebGL)
- Instanced rendering with quad geometry
- Custom vertex shader for gaussian projection
- Fragment shader with EWA splatting
- Web Worker for background depth sorting
- Three.js coordinate system (negative Z forward)

### Depth Sorting Algorithm

The renderer uses a **16-bit counting sort** for depth ordering, based on [antimatter15/splat](https://github.com/antimatter15/splat). This was chosen over other algorithms for performance:

| Algorithm | Time | Complexity |
|-----------|------|------------|
| `Array.sort` | ~0.9s | O(n log n) |
| Quick sort | ~0.4s | O(n log n) |
| **Count sort** | **~0.3s** | **O(n)** ✅ |

The counting sort is fastest because:
- **Single pass** - radix sort needs 4 passes for 32-bit values
- **No comparisons** - just bucket by quantized depth value
- **16-bit precision is sufficient** - we only need relative depth order

All sorting and attribute reordering happens in a Web Worker to keep the main thread responsive.


## License

Data Organization Format originated from XGRIDS.

Shader implementations adapted from MIT-licensed Gaussian Splatting WebGL project.

