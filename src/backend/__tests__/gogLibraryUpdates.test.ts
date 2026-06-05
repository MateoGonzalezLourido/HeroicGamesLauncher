// ---- Mocks (hoisted by Jest) ----

const mockAxiosGet = jest.fn()
jest.mock('backend/utils', () => ({
  axiosClient: { get: mockAxiosGet },
  getGOGdlBin: jest.fn(() => '/mock/gogdl'),
  getFileSize: jest.fn()
}))

jest.mock('backend/online_monitor', () => ({
  isOnline: jest.fn(),
  runOnceWhenOnline: jest.fn()
}))

jest.mock('backend/storeManagers/gog/user', () => ({
  GOGUser: {
    isLoggedIn: jest.fn(),
    getCredentials: jest.fn()
  }
}))

const mockInstalledStoreGet = jest.fn()
jest.mock('backend/storeManagers/gog/electronStores', () => ({
  installedGamesStore: { get: mockInstalledStoreGet, set: jest.fn() },
  libraryStore: { get: jest.fn(() => ({ games: [] })), set: jest.fn() },
  installInfoStore: {
    get: jest.fn(),
    set: jest.fn(),
    has: jest.fn(() => false)
  },
  apiInfoCache: { get: jest.fn(), set: jest.fn() },
  privateBranchesStore: { get: jest.fn(() => '') },
  achievementStore: { get: jest.fn(), set: jest.fn() },
  syncStore: { get: jest.fn(), set: jest.fn() }
}))

jest.mock('backend/logger', () => ({
  logInfo: jest.fn(),
  logWarning: jest.fn(),
  logDebug: jest.fn(),
  logError: jest.fn(),
  LogPrefix: { Gog: 'Gog' }
}))

jest.mock('backend/ipc', () => ({
  sendFrontendMessage: jest.fn(),
  addTestOnlyListener: jest.fn()
}))

jest.mock('backend/launcher', () => ({
  callRunner: jest.fn()
}))

jest.mock('backend/storeManagers/gog/redist', () => ({
  checkForRedistUpdates: jest.fn()
}))

jest.mock('backend/storeManagers/gog/constants', () => ({
  gogdlConfigPath: '/mock/gogdl-config'
}))

jest.mock('backend/constants/paths', () => ({
  userDataPath: '/mock/user-data'
}))

jest.mock('backend/storeManagers/gog/e2eMock', () => ({
  runGogdlCommandStub: jest.fn()
}))

jest.mock('graceful-fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}')
}))

jest.mock('node:fs', () => ({
  readdirSync: jest.fn(() => []),
  rmSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(() => true)
}))

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn()
}))

// ---- Module references (reset per test via isolateModulesAsync) ----

let listUpdateableGames: (typeof import('../storeManagers/gog/library'))['listUpdateableGames']
let refreshInstalled: (typeof import('../storeManagers/gog/library'))['refreshInstalled']
let mockIsOnline: jest.Mock
let mockIsLoggedIn: jest.Mock
let mockGetCredentials: jest.Mock
let mockLogWarning: jest.Mock

beforeEach(async () => {
  await jest.isolateModulesAsync(async () => {
    const lib = await import('backend/storeManagers/gog/library')
    listUpdateableGames = lib.listUpdateableGames
    refreshInstalled = lib.refreshInstalled

    const onlineMonitor = await import('backend/online_monitor')
    mockIsOnline = onlineMonitor.isOnline as jest.Mock

    const gogUser = await import('backend/storeManagers/gog/user')
    mockIsLoggedIn = gogUser.GOGUser.isLoggedIn as jest.Mock
    mockGetCredentials = gogUser.GOGUser.getCredentials as jest.Mock

    const logger = await import('backend/logger')
    mockLogWarning = logger.logWarning as jest.Mock
  })
})

// ---- Helpers ----

type InstalledEntry = {
  appName: string
  platform: string
  version?: string
  versionEtag?: string
  pinnedVersion?: boolean
}

function setupInstalledGames(games: InstalledEntry[]) {
  mockInstalledStoreGet.mockReturnValue(games)
  refreshInstalled()
}

/**
 * mockAxiosGet implementation that routes by URL:
 *   content-system.gog.com → builds endpoint (returns CDN meta URL for the appName)
 *   mock-cdn/<appName>      → meta endpoint
 *   api.gog.com/products    → product API (linux installers)
 */
function setupAxiosMock(
  gameUpdates: Record<string, 'has-update' | 'no-update' | 'throws'>,
  linuxVersions: Record<string, string> = {}
) {
  mockAxiosGet.mockImplementation((url: string) => {
    // Builds endpoint: extract appName from URL path segment
    if (url.includes('content-system.gog.com')) {
      const appName = url.split('/products/')[1].split('/os/')[0]
      if (gameUpdates[appName] === 'throws') {
        return Promise.reject(new Error(`Network error for ${appName}`))
      }
      return Promise.resolve({
        data: {
          items: [
            {
              urls: [{ url: `https://mock-cdn/${appName}` }],
              branch: null
            }
          ]
        }
      })
    }

    // Meta endpoint
    if (url.includes('mock-cdn/')) {
      const appName = url.split('mock-cdn/')[1]
      const storedEtag = 'stored-etag'
      const newEtag =
        gameUpdates[appName] === 'has-update' ? 'new-etag' : storedEtag
      return Promise.resolve({
        status: 200,
        headers: { etag: newEtag }
      })
    }

    // Product API (linux games)
    if (url.includes('api.gog.com/products/')) {
      const appName = url.split('/products/')[1].split('?')[0]
      const version = linuxVersions[appName] ?? 'v2.0'
      return Promise.resolve({
        data: {
          downloads: {
            installers: [{ os: 'linux', version }]
          }
        }
      })
    }

    return Promise.reject(new Error(`Unmocked URL: ${url}`))
  })
}

// ---- Tests ----

describe('listUpdateableGames', () => {
  beforeEach(() => {
    mockIsOnline.mockReturnValue(true)
    mockIsLoggedIn.mockReturnValue(true)
    mockGetCredentials.mockResolvedValue({ access_token: 'mock-token' })
  })

  it('returns [] when offline', async () => {
    mockIsOnline.mockReturnValue(false)

    const result = await listUpdateableGames()

    expect(result).toEqual([])
    expect(mockAxiosGet).not.toHaveBeenCalled()
  })

  it('returns [] when user is not logged in', async () => {
    mockIsLoggedIn.mockReturnValue(false)

    const result = await listUpdateableGames()

    expect(result).toEqual([])
    expect(mockAxiosGet).not.toHaveBeenCalled()
  })

  it('returns [] when no games are installed', async () => {
    setupInstalledGames([])

    const result = await listUpdateableGames()

    expect(result).toEqual([])
  })

  it('returns only games that have an update available', async () => {
    setupInstalledGames([
      { appName: 'game-a', platform: 'Windows', versionEtag: 'stored-etag' },
      { appName: 'game-b', platform: 'Windows', versionEtag: 'stored-etag' }
    ])
    setupAxiosMock({ 'game-a': 'has-update', 'game-b': 'no-update' })

    const result = await listUpdateableGames()

    expect(result).toContain('game-a')
    expect(result).not.toContain('game-b')
  })

  it('skips pinned games without making HTTP requests', async () => {
    setupInstalledGames([
      {
        appName: 'pinned-game',
        platform: 'Windows',
        versionEtag: 'v1',
        pinnedVersion: true
      }
    ])

    const result = await listUpdateableGames()

    expect(result).toEqual([])
    expect(mockAxiosGet).not.toHaveBeenCalled()
    expect(mockLogWarning).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('pinned-game')]),
      expect.anything()
    )
  })

  it('uses the linux installer check for linux games', async () => {
    setupInstalledGames([
      { appName: 'linux-game', platform: 'linux', version: 'v1.0' }
    ])
    // API reports v2.0 → versions differ → game has update
    setupAxiosMock({}, { 'linux-game': 'v2.0' })

    const result = await listUpdateableGames()

    expect(result).toContain('linux-game')
    // Must NOT hit the builds/meta endpoints used by the Windows path
    expect(mockAxiosGet).not.toHaveBeenCalledWith(
      expect.stringContaining('content-system.gog.com'),
      expect.anything()
    )
  })

  it('does not report linux games whose installer version matches', async () => {
    setupInstalledGames([
      { appName: 'linux-game', platform: 'linux', version: 'v1.0' }
    ])
    // API also reports v1.0 → up to date
    setupAxiosMock({}, { 'linux-game': 'v1.0' })

    const result = await listUpdateableGames()

    expect(result).not.toContain('linux-game')
  })

  it('skips a game that throws during the update check and processes the rest', async () => {
    setupInstalledGames([
      { appName: 'good-game', platform: 'Windows', versionEtag: 'stored-etag' },
      {
        appName: 'error-game',
        platform: 'Windows',
        versionEtag: 'stored-etag'
      }
    ])
    setupAxiosMock({ 'good-game': 'has-update', 'error-game': 'throws' })

    const result = await listUpdateableGames()

    expect(result).toContain('good-game')
    expect(result).not.toContain('error-game')
    expect(mockLogWarning).toHaveBeenCalledWith(
      expect.stringContaining('error-game'),
      expect.anything()
    )
  })

  it('processes all games even when several fail', async () => {
    setupInstalledGames([
      { appName: 'ok-1', platform: 'Windows', versionEtag: 'stored-etag' },
      { appName: 'fail-1', platform: 'Windows', versionEtag: 'stored-etag' },
      { appName: 'ok-2', platform: 'Windows', versionEtag: 'stored-etag' },
      { appName: 'fail-2', platform: 'Windows', versionEtag: 'stored-etag' }
    ])
    setupAxiosMock({
      'ok-1': 'has-update',
      'fail-1': 'throws',
      'ok-2': 'has-update',
      'fail-2': 'throws'
    })

    const result = await listUpdateableGames()

    expect(result).toEqual(expect.arrayContaining(['ok-1', 'ok-2']))
    expect(result).toHaveLength(2)
  })
})
