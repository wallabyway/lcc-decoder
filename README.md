# LCC 3D Gaussian Splatting Viewer

A reference LCC Decoder in js - minimal Three.js viewer of 3D Gaussian Splats data decoded from XGRIDS "LCC" Format (Lixel CyberColor).

### **Demos: ** 
- This demo: https://wallabyway.github.io/lcc-decoder/
- XGRIDS web viewer [demo](https://lcc-viewer.xgrids.com/?data=https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc)

https://github.com/user-attachments/assets/24949ce9-44cf-4daf-bfe1-ef657e382c07

![Image](https://github.com/user-attachments/assets/e272e4e5-f11e-4f72-a904-2e2d6e08889f)


> Note: install the `allow CORS` [chrome extension](https://chromewebstore.google.com/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf)

## Features

### LCC Format Support
- Loads and decodes LCC data files (the `meta.lcc` is json, see `LCC Data Format` below ).
- Loads the `index.bin` as a guide on where to find byte offset to binary chunks in the `data.bin` which reference different Level of Detail streams and spatial streams.
- The `index.bin` contains 2D grid spatial regions.  Use this for spatial streaming with LODs
- this example uses Range GET requests, to stream a 24MB portion of the 2GB `data.bin` - to display LOD 4.  The same can be done for spatial streaming of a 2D grid.

### Misc
-  **Three.js Integration** - Custom 3DGS Frag/Vert shader with material for gaussian splat rendering, using `DepthFirstSort`.
-  **Depth Sorting** - simple depth sorting via CPU Web Worker for proper transparency - hence the 'popping'


## File Structure

```
root/
├── index.html          # minimal Three js viewer
├── lcc-loader.js       # LCC format decoder
├── splat-renderer.js   # Three.js gaussian splat renderer (Frag and Vert shaders)
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

(optional) **Load remote LCC data from URL:**

   Example URL: https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc

   Add a `?data=` parameter with the URL to the LCC file or directory:
   ```
http://localhost:8000/?data=https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc
   ```


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


### LCC Decoder (`lcc-loader.js`)
Loads and decodes LCC data files (meta.lcc is json). Uses `Index.bin` to choose LOD and spatial blobs found inside `Data.bin`. Streaming via Range GET requests to do partial loading of `Data.bin`
- Starts by reading `meta.lcc` json file, for scene metadata
- Parses Index.bin to find byte offsets of LOD (and x,y regions)
- Parses Data.bin with proper byte offsets
- Decodes compressed rotation quaternions using lookup table
- Interpolates scales using min/max from metadata
- Computes 3D covariance matrices from scale + rotation

### Renderer (`splat-renderer.js`)

Rendering adapted entirely from [kishimisu/Gaussian-Splatting-WebGL](https://github.com/kishimisu/Gaussian-Splatting-WebGL)
- Instanced rendering with quad geometry
- Custom vertex shader for gaussian projection
- Fragment shader with EWA splatting
- Web Worker for background depth sorting
- Three.js coordinate system (negative Z forward)


### Coordinate System

LCC format uses **Z-up coordinates** while Three.js uses **Y-up coordinates**. The viewer handles this via forcing camera-up nav.  This may change (idk).


### XGRIDS Specs, Sample Data and More
- XGRIDS Viewer Demo using their SDK: https://lcc-viewer.xgrids.com/?data=https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc
- XGRIDS Web SDK: https://developer.xgrids.com/#/download?page=LCC_WEB_SDK
- More LCC Sample scenes from XGRIDS: [https://developer.xgrids.com/#/download?page=LCC_WEB_SDK](https://developer.xgrids.com/#/download?page=sampledata)

![Image](https://github.com/user-attachments/assets/19e734b9-b2c2-487b-8ab8-853293bb3f18)

### Sharing LCC with SuperSplat
- Supersplat announce support for LCC: https://www.reddit.com/r/PlayCanvas/comments/1obkf4x/supersplat_2120_xgrids_lcc_support_flood_fill/
- Editing LCC inside SuperSplat editor: https://superspl.at/editor?load=https://raw.githubusercontent.com/willeastcott/assets/main/lcc/bigmirror/meta.lcc&focal=-2,1,1.75&distance=0.8&camera.overlay=false
- Autodesk ACC with LCC - DevCon2024 Presentation  - https://aps.autodesk.com/blog/devcon-amsterdam-ssa-workshops-x-grids-gaussian-splats-meetup

## License
MIT

Data Organization Format originated from XGRIDS.

Shader implementations adapted from MIT-licensed Gaussian Splatting WebGL project.

