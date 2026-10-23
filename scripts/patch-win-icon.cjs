#!/usr/bin/env node
/**
 * Embed the launcher icon and version strings into the Windows PE without Wine.
 * electron-builder's zip target runs with signAndEditExecutable=false on Linux;
 * this script patches release/win-unpacked/BerryLauncher.exe and rewrites the zip.
 */
const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const PELibrary = require('pe-library')
const ResEdit = require('resedit')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const exePath = path.join(root, 'release', 'win-unpacked', 'BerryLauncher.exe')
const iconPath = path.join(root, 'build', 'icon.ico')
if (!fs.existsSync(exePath)) {
  console.error('[icon] missing', exePath)
  process.exit(1)
}
if (!fs.existsSync(iconPath)) {
  console.error('[icon] missing', iconPath)
  process.exit(1)
}

const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
const res = PELibrary.NtExecutableResource.from(exe)
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
const group = groups[0]
if (!group) throw new Error('no icon group in exe')
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  group.id,
  group.lang,
  iconFile.icons.map((item) => item.data),
)

const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
if (versionInfo) {
  versionInfo.setFileVersion(pkg.version, 1033)
  versionInfo.setProductVersion(pkg.version, 1033)
  versionInfo.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'BerryLauncher · 甜浆果启动器',
      ProductName: 'BerryLauncher',
      CompanyName: 'USTL Sweet Berry Pixel Club',
      LegalCopyright: 'Copyright © 2026 USTL Sweet Berry Pixel Club',
      OriginalFilename: 'BerryLauncher.exe',
      InternalName: 'BerryLauncher',
    },
  )
  versionInfo.outputToResourceEntries(res.entries)
}
res.outputResource(exe)
const output = Buffer.from(exe.generate())
const tmp = `${exePath}.icon-tmp`
fs.writeFileSync(tmp, output)
fs.renameSync(tmp, exePath)

const zipPath = path.join(root, 'release', `BerryLauncher-${pkg.version}-win.zip`)
if (fs.existsSync(zipPath)) {
  const zip = new AdmZip(zipPath)
  zip.updateFile('BerryLauncher.exe', output)
  zip.writeZip(zipPath)
}
console.log('[icon] patched', exePath, `${output.length} bytes`)
