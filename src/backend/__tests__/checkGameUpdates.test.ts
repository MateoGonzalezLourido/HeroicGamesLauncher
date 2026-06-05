// Tests the parallel update-check logic introduced in the checkGameUpdates IPC handler.
// Importing main.ts directly requires mocking ~30 Electron and backend modules, so the
// handler logic is replicated here to verify the Promise.allSettled contract in isolation.

import type { Runner } from 'common/types'

type MockManager = { listUpdateableGames: jest.Mock }
type MockMap = Partial<Record<Runner, MockManager>>

async function runHandler(
  libraryManagerMap: MockMap,
  autoUpdateGames: boolean,
  autoUpdate: (runner: Runner, games: string[]) => string[],
  logError: jest.Mock
): Promise<string[]> {
  const runners = Object.keys(libraryManagerMap) as Runner[]
  const results = await Promise.allSettled(
    runners.map(async (runner) => {
      let games = await libraryManagerMap[runner]!.listUpdateableGames()
      if (autoUpdateGames) games = autoUpdate(runner, games)
      return games
    })
  )
  return results.flatMap((result) => {
    if (result.status === 'rejected') {
      logError(`Update check failed for a runner: ${result.reason}`)
      return []
    }
    return result.value
  })
}

describe('checkGameUpdates handler logic', () => {
  const logError = jest.fn()
  const noopAutoUpdate = (_runner: Runner, games: string[]) => games

  it('combines results from all runners', async () => {
    const map: MockMap = {
      legendary: {
        listUpdateableGames: jest.fn().mockResolvedValue(['epic1'])
      },
      gog: {
        listUpdateableGames: jest.fn().mockResolvedValue(['gog1', 'gog2'])
      },
      nile: { listUpdateableGames: jest.fn().mockResolvedValue([]) }
    }

    const result = await runHandler(map, false, noopAutoUpdate, logError)

    expect(result).toEqual(expect.arrayContaining(['epic1', 'gog1', 'gog2']))
    expect(result).toHaveLength(3)
    expect(map.legendary!.listUpdateableGames).toHaveBeenCalledTimes(1)
    expect(map.gog!.listUpdateableGames).toHaveBeenCalledTimes(1)
    expect(map.nile!.listUpdateableGames).toHaveBeenCalledTimes(1)
  })

  it('skips a failing runner and returns results from the rest', async () => {
    const map: MockMap = {
      legendary: {
        listUpdateableGames: jest.fn().mockResolvedValue(['epic1'])
      },
      gog: {
        listUpdateableGames: jest
          .fn()
          .mockRejectedValue(new Error('GOG API down'))
      },
      nile: { listUpdateableGames: jest.fn().mockResolvedValue(['amazon1']) }
    }

    const result = await runHandler(map, false, noopAutoUpdate, logError)

    expect(result).toEqual(expect.arrayContaining(['epic1', 'amazon1']))
    expect(result).not.toContain('gog')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('GOG API down')
    )
  })

  it('calls autoUpdate per runner when autoUpdateGames is true', async () => {
    const autoUpdate = jest.fn((_runner: Runner, games: string[]) => games)
    const map: MockMap = {
      legendary: {
        listUpdateableGames: jest.fn().mockResolvedValue(['epic1'])
      },
      gog: { listUpdateableGames: jest.fn().mockResolvedValue(['gog1']) }
    }

    await runHandler(map, true, autoUpdate, logError)

    expect(autoUpdate).toHaveBeenCalledTimes(2)
    expect(autoUpdate).toHaveBeenCalledWith('legendary', ['epic1'])
    expect(autoUpdate).toHaveBeenCalledWith('gog', ['gog1'])
  })

  it('does not call autoUpdate when autoUpdateGames is false', async () => {
    const autoUpdate = jest.fn((_runner: Runner, games: string[]) => games)
    const map: MockMap = {
      legendary: { listUpdateableGames: jest.fn().mockResolvedValue(['epic1']) }
    }

    await runHandler(map, false, autoUpdate, logError)

    expect(autoUpdate).not.toHaveBeenCalled()
  })

  it('returns empty array when all runners fail', async () => {
    const map: MockMap = {
      legendary: {
        listUpdateableGames: jest.fn().mockRejectedValue(new Error('epic fail'))
      },
      gog: {
        listUpdateableGames: jest.fn().mockRejectedValue(new Error('gog fail'))
      }
    }

    const result = await runHandler(map, false, noopAutoUpdate, logError)

    expect(result).toEqual([])
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
