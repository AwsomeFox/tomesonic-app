const CACHE_TTL_MS = 5 * 60 * 1000

const peopleStatsCacheByLibrary = {}

function normalizeName(name) {
  if (!name || typeof name !== 'string') return ''
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function defaultEncode(value) {
  const stringValue = `${value || ''}`
  if (typeof btoa === 'function') {
    return encodeURIComponent(btoa(stringValue))
  }
  if (typeof Buffer !== 'undefined') {
    return encodeURIComponent(Buffer.from(stringValue, 'utf8').toString('base64'))
  }
  return encodeURIComponent(stringValue)
}

function getNumericCount(value) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  return 0
}

function getPayloadResults(payload) {
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload)) return payload
  return []
}

function getPayloadTotal(payload, fallbackLength = 0) {
  const candidates = [payload?.total, payload?.totalCount, payload?.totalResults, payload?.numResults, payload?.meta?.total]
  for (let i = 0; i < candidates.length; i += 1) {
    const parsed = Number(candidates[i])
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed)
    }
  }
  return Math.floor(fallbackLength)
}

export function clearAudioPeopleStatsCache(libraryId = null) {
  if (libraryId) {
    delete peopleStatsCacheByLibrary[libraryId]
    return
  }

  Object.keys(peopleStatsCacheByLibrary).forEach((cacheKey) => {
    delete peopleStatsCacheByLibrary[cacheKey]
  })
}

export function unwrapBookEntity(entity) {
  if (!entity) return null
  return entity.libraryItem || entity.item || entity.libraryItemWrapper || entity
}

export function isBookEntityAudioCapable(entity) {
  const source = unwrapBookEntity(entity)
  if (!source) return false

  if (source.mediaType && source.mediaType !== 'book') return true

  const media = source.media || source
  const numTracks = getNumericCount(media?.numTracks || media?.numAudioTracks)
  if (numTracks > 0) return true

  if (Array.isArray(media?.audioFiles) && media.audioFiles.length > 0) return true
  if (Array.isArray(media?.tracks) && media.tracks.length > 0) return true

  return false
}

export function getAuthorRefsFromBookEntity(bookEntity) {
  const source = unwrapBookEntity(bookEntity) || bookEntity
  const refs = []
  const metadata = source?.media?.metadata || source?.metadata || source?.mediaMetadata || null

  const parseAuthorRef = (candidate) => {
    if (!candidate) return null

    if (typeof candidate === 'string') {
      return {
        id: null,
        name: candidate,
        libraryId: source?.libraryId || null
      }
    }

    const nestedAuthor = candidate.author || null
    const id = candidate.id || candidate.authorId || nestedAuthor?.id || null
    const name = candidate.name || nestedAuthor?.name || candidate.authorName || null
    if (!name && !id) return null

    return {
      id,
      name: name || 'Unknown Author',
      libraryId: candidate.libraryId || nestedAuthor?.libraryId || source?.libraryId || null
    }
  }

  const rawAuthors = metadata?.authors || source?.authors || source?.media?.authors
  const authors = Array.isArray(rawAuthors) ? rawAuthors : rawAuthors ? [rawAuthors] : []
  authors.forEach((authorRef) => {
    const parsed = parseAuthorRef(authorRef)
    if (parsed) refs.push(parsed)
  })

  const fallbackAuthorName = metadata?.authorName || metadata?.author || source?.authorName || source?.author || source?.media?.authorName || source?.media?.author || null
  if (!refs.length && fallbackAuthorName) {
    const parsedFallback = parseAuthorRef(fallbackAuthorName)
    if (parsedFallback) refs.push(parsedFallback)
  }

  const deduped = []
  const keys = new Set()
  refs.forEach((ref) => {
    const key = ref.id || (ref.name ? `name:${normalizeName(ref.name)}` : null)
    if (key && !keys.has(key)) {
      keys.add(key)
      deduped.push(ref)
    }
  })

  return deduped
}

export function getNarratorRefsFromBookEntity(bookEntity) {
  const source = unwrapBookEntity(bookEntity) || bookEntity
  const refs = []
  const metadata = source?.media?.metadata || source?.metadata || source?.mediaMetadata || null

  const toNarratorNameList = (rawValue) => {
    if (!rawValue) return []

    if (Array.isArray(rawValue)) {
      return rawValue.flatMap((value) => toNarratorNameList(value)).filter((value, index, arr) => arr.indexOf(value) === index)
    }

    if (typeof rawValue === 'string') {
      return rawValue
        .split(/[,;]\s*/)
        .map((value) => value.trim())
        .filter(Boolean)
    }

    return []
  }

  const parseNarratorRef = (candidate) => {
    if (!candidate) return null

    if (typeof candidate === 'string') {
      return {
        name: candidate,
        libraryId: source?.libraryId || null
      }
    }

    const name = candidate.name || candidate.narratorName || candidate.narrator || candidate.displayName || null
    if (!name) return null

    return {
      name,
      libraryId: candidate.libraryId || source?.libraryId || null
    }
  }

  const rawNarrators = metadata?.narrators || source?.narrators || source?.media?.narrators
  const narrators = Array.isArray(rawNarrators) ? rawNarrators : rawNarrators ? [rawNarrators] : []
  narrators.forEach((narratorRef) => {
    const parsed = parseNarratorRef(narratorRef)
    if (parsed) refs.push(parsed)
  })

  const fallbackNarratorNames = [metadata?.narratorName, metadata?.narrator, source?.narratorName, source?.narrator, source?.media?.narratorName, source?.media?.narrator]
  fallbackNarratorNames.forEach((fallbackValue) => {
    toNarratorNameList(fallbackValue).forEach((narratorName) => {
      const parsed = parseNarratorRef(narratorName)
      if (parsed) refs.push(parsed)
    })
  })

  const deduped = []
  const keys = new Set()
  refs.forEach((ref) => {
    const normalizedName = normalizeName(ref.name)
    if (!normalizedName) return
    if (keys.has(normalizedName)) return
    keys.add(normalizedName)
    deduped.push(ref)
  })

  return deduped
}

async function fetchAllEbookOnlyBooks(libraryId, nativeHttp, encodeFn) {
  const encodedNone = typeof encodeFn === 'function' ? encodeFn('none') : defaultEncode('none')
  const limit = 200
  const maxPages = 300
  const ebookOnlyBooks = []

  let page = 0
  let keepPaging = true

  while (keepPaging && page < maxPages) {
    const searchParams = new URLSearchParams()
    searchParams.set('filter', `tracks.${encodedNone}`)
    searchParams.set('limit', `${limit}`)
    searchParams.set('page', `${page}`)
    searchParams.set('minified', '1')

    const payload = await nativeHttp.get(`/api/libraries/${libraryId}/items?${searchParams.toString()}`, { connectTimeout: 10000 }).catch((error) => {
      console.error('[audioFiltering] Failed to load ebook-only books', error)
      return null
    })

    if (!payload) break

    const results = getPayloadResults(payload)
    if (!results.length) break

    ebookOnlyBooks.push(...results)

    const total = getPayloadTotal(payload, results.length)
    page += 1

    if (results.length < limit || page * limit >= total) {
      keepPaging = false
    }
  }

  return ebookOnlyBooks
}

export async function getAudioPeopleStatsForLibrary(options = {}) {
  const libraryId = options.libraryId
  const nativeHttp = options.nativeHttp
  const encodeFn = options.encode
  const includeEbookOnly = !!options.includeEbookOnly
  const forceRefresh = !!options.forceRefresh

  if (!libraryId || !nativeHttp) {
    return {
      authorTotalsById: {},
      authorAudioCountsById: {},
      authorAudioCountsByName: {},
      narratorTotalsByName: {},
      narratorAudioCountsByName: {},
      narratorDisplayNameByName: {},
      ebookOnlyBookIds: {}
    }
  }

  const cached = peopleStatsCacheByLibrary[libraryId]
  if (!forceRefresh && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    if (includeEbookOnly || !cached.missingEbookOnly) {
      return cached.data
    }
  }

  const [authorsPayload, narratorsPayload, ebookOnlyBooks] = await Promise.all([
    nativeHttp.get(`/api/libraries/${libraryId}/authors`, { connectTimeout: 10000 }).catch((error) => {
      console.error('[audioFiltering] Failed to load author totals', error)
      return null
    }),
    nativeHttp.get(`/api/libraries/${libraryId}/narrators`, { connectTimeout: 10000 }).catch((error) => {
      console.error('[audioFiltering] Failed to load narrator totals', error)
      return null
    }),
    includeEbookOnly ? fetchAllEbookOnlyBooks(libraryId, nativeHttp, encodeFn) : Promise.resolve([])
  ])

  const authorTotalsById = {}
  const authorTotalsByName = {}
  const narratorTotalsByName = {}
  const narratorDisplayNameByName = {}

  const authors = Array.isArray(authorsPayload?.authors) ? authorsPayload.authors : getPayloadResults(authorsPayload)
  authors.forEach((authorEntity) => {
    if (!authorEntity?.name && !authorEntity?.id) return

    const totalBooks = getNumericCount(authorEntity.numBooks || authorEntity.totalBooks)
    if (authorEntity.id) {
      authorTotalsById[authorEntity.id] = totalBooks
    }

    const normalizedName = normalizeName(authorEntity.name)
    if (normalizedName) {
      authorTotalsByName[normalizedName] = totalBooks
    }
  })

  const narrators = Array.isArray(narratorsPayload?.narrators) ? narratorsPayload.narrators : getPayloadResults(narratorsPayload)
  narrators.forEach((narratorEntity) => {
    const narratorName = narratorEntity?.name || narratorEntity
    const normalizedName = normalizeName(narratorName)
    if (!normalizedName) return

    narratorTotalsByName[normalizedName] = getNumericCount(narratorEntity?.numBooks || narratorEntity?.totalBooks)
    narratorDisplayNameByName[normalizedName] = narratorName
  })

  const ebookOnlyBookIds = {}
  const ebookOnlyAuthorCountsById = {}
  const ebookOnlyAuthorCountsByName = {}
  const ebookOnlyNarratorCountsByName = {}

  ebookOnlyBooks.forEach((bookEntity) => {
    const sourceBook = unwrapBookEntity(bookEntity) || bookEntity
    const sourceBookId = sourceBook?.id || sourceBook?.libraryItemId || null
    if (sourceBookId) {
      ebookOnlyBookIds[sourceBookId] = true
    }

    const authorsForBook = getAuthorRefsFromBookEntity(sourceBook)
    authorsForBook.forEach((authorRef) => {
      if (authorRef?.id) {
        ebookOnlyAuthorCountsById[authorRef.id] = getNumericCount(ebookOnlyAuthorCountsById[authorRef.id]) + 1
      }

      const normalizedName = normalizeName(authorRef?.name)
      if (normalizedName) {
        ebookOnlyAuthorCountsByName[normalizedName] = getNumericCount(ebookOnlyAuthorCountsByName[normalizedName]) + 1
      }
    })

    const narratorsForBook = getNarratorRefsFromBookEntity(sourceBook)
    narratorsForBook.forEach((narratorRef) => {
      const normalizedName = normalizeName(narratorRef?.name)
      if (!normalizedName) return
      ebookOnlyNarratorCountsByName[normalizedName] = getNumericCount(ebookOnlyNarratorCountsByName[normalizedName]) + 1
    })
  })

  const authorAudioCountsById = {}
  const authorAudioCountsByName = {}

  Object.keys(authorTotalsById).forEach((authorId) => {
    const totalCount = getNumericCount(authorTotalsById[authorId])
    const ebookOnlyCount = getNumericCount(ebookOnlyAuthorCountsById[authorId])
    authorAudioCountsById[authorId] = Math.max(0, totalCount - ebookOnlyCount)
  })

  Object.keys(authorTotalsByName).forEach((normalizedName) => {
    const totalCount = getNumericCount(authorTotalsByName[normalizedName])
    const ebookOnlyCount = getNumericCount(ebookOnlyAuthorCountsByName[normalizedName])
    authorAudioCountsByName[normalizedName] = Math.max(0, totalCount - ebookOnlyCount)
  })

  const narratorAudioCountsByName = {}
  Object.keys(narratorTotalsByName).forEach((normalizedName) => {
    const totalCount = getNumericCount(narratorTotalsByName[normalizedName])
    const ebookOnlyCount = getNumericCount(ebookOnlyNarratorCountsByName[normalizedName])
    narratorAudioCountsByName[normalizedName] = Math.max(0, totalCount - ebookOnlyCount)
  })

  const data = {
    authorTotalsById,
    authorTotalsByName,
    authorAudioCountsById,
    authorAudioCountsByName,
    narratorTotalsByName,
    narratorAudioCountsByName,
    narratorDisplayNameByName,
    ebookOnlyBookIds
  }

  peopleStatsCacheByLibrary[libraryId] = {
    loadedAt: Date.now(),
    missingEbookOnly: !includeEbookOnly,
    data
  }

  return data
}
