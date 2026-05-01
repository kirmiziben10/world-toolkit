# Third-Party Notices

This project includes or adapts material from the third-party projects below.

## Silk Icons

Some UI icons in `assets/` are adapted from the Silk icon set by Mark James.

- Original project: http://www.famfamfam.com/lab/icons/silk/
- Source package mirror: https://github.com/legacy-icons/famfamfam-silk
- License: Creative Commons Attribution 2.5
- License URL: https://creativecommons.org/licenses/by/2.5/

Repository note from `legacy-icons/famfamfam-silk/LICENSE.md`:

> Mark James http://www.famfamfam.com/lab/icons/silk/
>
> This work is licensed under a Creative Commons Attribution 2.5 License.
>
> This means you may use it for any purpose, and make any changes you like. All I ask is that you include a link back to this page in your credits.

This project uses adapted SVG versions of selected Silk icons and includes credit back to the original Silk icon page in the in-app help/credits UI.

## Three.js

`vendor/desktop-buddy/desktop-buddy.iife.js` bundles portions of Three.js.

- Project: https://threejs.org/
- Source: https://github.com/mrdoob/three.js
- License: MIT

MIT license text:

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## NTIA Irregular Terrain Model (ITM)

`vendor/itm/itm.js` is a JavaScript port of the NTIA/ITS Irregular Terrain Model (Longley-Rice) C++ reference implementation.

- Project: https://github.com/NTIA/itm
- Version: v1.4
- License: Public domain (US government work, 17 U.S.C. § 105)

> SOFTWARE DISCLAIMER / RELEASE
>
> Software code created by U.S. Government employees is not subject to
> copyright in the United States (17 U.S.C. §105). The United States/
> Department of Commerce reserves all rights to seek and obtain copyright
> protection in countries other than the United States for Software
> authored in its entirety by the Department of Commerce. To this end,
> the Department of Commerce hereby grants to Recipient a royalty-free,
> nonexclusive license to use, copy, and create derivative works of the
> Software outside of the United States.

## Mapzen Terrain Tiles / Terrain Tiles on AWS Open Data

`terrain-tiles.js` fetches Terrarium-encoded elevation tiles from the public `elevation-tiles-prod` bucket on AWS Open Data:

- Dataset registry: https://registry.opendata.aws/terrain-tiles/
- Hosted tile endpoint used by this project: `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`
- Documentation and attribution guide: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- Managed by: Mapzen, a Linux Foundation project

The AWS dataset registry points to the Mapzen/Terrain Tiles attribution guide as the applicable credit source. This project uses the hosted terrain tile service, so the hosted-service attribution recommended by the official guide is reproduced below.

```text
Mapzen
ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
Canada terrain data contains information licensed under the Open Government Licence – Canada;
Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;
Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
Mexico terrain data source: INEGI, Continental relief, 2016;
New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);
Norway terrain data © Kartverket;
United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;
United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.
```
