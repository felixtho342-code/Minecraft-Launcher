const repository = process.env.GITHUB_REPOSITORY ?? 'felixtho342-code/Minecraft-Launcher'
const [owner, repo] = repository?.split('/') ?? []

if (!owner || !repo) {
  throw new Error('GITHUB_REPOSITORY muss im Format OWNER/REPOSITORY angegeben werden.')
}

module.exports = {
  appId: 'de.local.minecraftlauncher',
  productName: 'PrismClient',
  artifactName: 'PrismClient-Setup-${version}.${ext}',
  directories: {
    output: 'release',
  },
  files: [
    'out/**/*',
  ],
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
  },
  publish: [{ provider: 'github', owner, repo }],
}
