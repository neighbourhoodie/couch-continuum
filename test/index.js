/* globals describe, it, beforeEach, before, afterEach */

const assert = require('assert').strict
const CouchContinuum = require('..')
const request = require('../lib/request')
const { name, version } = require('../package.json')

describe([name, version].join(' @ '), function () {
  this.timeout(1000 * 20)
  const couchUrl = process.env.COUCH_URL || 'http://localhost:5984'
  const dbName = 'test-continuum'
  const q = 4

  before(async function () {
    const { version } = await request({ url: couchUrl, json: true })
    this.couchVersion = version
  })

  beforeEach(async function () {
    // ensure db exists
    const url = `${couchUrl}/${dbName}`
    try {
      await request({ url, method: 'PUT' })
    } catch (error) {
      if (error.error !== 'file_exists') {
        throw error
      }
    }
    await request({
      url: [url, '_bulk_docs'].join('/'),
      method: 'POST',
      json: {
        docs: [1, 2, 3, 4, 5].map((n) => {
          return { _id: `doc_${n}` }
        })
      }
    })
  })

  afterEach(async function () {
    // destroy dbs
    const urls = ['', 'temp_copy_'].map((s) => {
      return `${couchUrl}/${s}${dbName}`
    })
    for (const url of urls) {
      try {
        await request({ url, method: 'DELETE' })
      } catch (error) {
        if (error.error !== 'not_found') {
          throw error
        }
      }
    }
  })

  it('should exist', function () {
    assert(CouchContinuum)
  })

  it('should retrieve all non-special dbs', async function () {
    const dbNames = await CouchContinuum.allDbs(couchUrl)
    assert(dbNames.length > 0)
    dbNames.forEach((dbName) => {
      assert.notStrictEqual(dbName[0], '_')
    })
    assert(dbNames.includes(dbName))
  })

  it('should create replicas repeatedly OK', async function () {
    const options = { couchUrl, source: dbName, q }
    const continuum = new CouchContinuum(options)
    await continuum.createReplica()
    await continuum.createReplica()
  })

  it('should replicate and replace a primary', async function () {
    this.timeout(30 * 1000) // 30s
    const options = { couchUrl, source: dbName, q }
    const continuum = new CouchContinuum(options)
    // create a replica and replace the primary
    await continuum.createReplica()
    await continuum.replacePrimary()
    // verify cleanup
    try {
      await request({ url: `${couchUrl}/temp_copy_${dbName}`, json: true })
    } catch (error) {
      assert.strictEqual(error.error, 'not_found')
    }
  })

  it('should check if a db is in use', async function () {
    const continuum = new CouchContinuum({ couchUrl, source: dbName, q })
    await continuum._isInUse(dbName)
  })

  it('should filter tombstones', async function () {
    if (this.couchVersion < '2') return this.skip() // 1.x needs a special index
    const options = { couchUrl, source: dbName, filterTombstones: true }
    // get tombstone
    const doc = await request({ url: `${couchUrl}/${dbName}/doc_1`, json: true })
    await request({ url: `${couchUrl}/${dbName}/doc_1?rev=${doc._rev}`, method: 'DELETE' })
    const { results: beforeResults } = await request({ url: `${couchUrl}/${dbName}/_changes`, json: true })
    const [tombstone] = beforeResults.filter(({ deleted }) => { return deleted })
    const { id, changes: [{ rev }] } = tombstone
    assert.strictEqual(doc._id, id)
    assert.strictEqual(doc._rev[0], '1')
    assert.strictEqual(rev[0], '2')
    // create replica
    const continuum = new CouchContinuum(options)
    await continuum.createReplica()
    // check that tombstones were actually filtered
    const { results: afterResults } = await request({ url: `${couchUrl}/temp_copy_${dbName}/_changes`, json: true })
    const tombstones = afterResults.filter(({ deleted }) => { return deleted })
    assert.strictEqual(tombstones.length, 0)
  })

  it('should modify n', async function () {
    const options = { couchUrl, source: dbName, n: 1 }
    const continuum = new CouchContinuum(options)
    await continuum.createReplica()
    const url = [couchUrl, continuum.db2].join('/')
    const { cluster } = await request({ url, json: true })
    if (cluster !== undefined) {
      // exception for travis, which runs couchdb 1.x
      assert.strictEqual(cluster.n, 1, `n should be 1 but is ${cluster.n}.`)
    }
  })

  it('should migrate all OK', async function () {
    this.timeout(30 * 1000)
    const continuums = [new CouchContinuum({ couchUrl, source: dbName, q })]
    await CouchContinuum.createReplicas(continuums)
    await CouchContinuum.replacePrimaries(continuums)
  })

  it('should handle checkpoints OK', async function () {
    const allDbs = await CouchContinuum.getRemaining(couchUrl)
    function getRemaining (checkpoint) {
      return allDbs.filter((dbName) => { return dbName > checkpoint })
    }
    let checkpoint = await CouchContinuum.getCheckpoint()
    assert.strictEqual(getRemaining(checkpoint).length, allDbs.length)
    await CouchContinuum.makeCheckpoint('\uffff')
    checkpoint = await CouchContinuum.getCheckpoint()
    assert.strictEqual(getRemaining(checkpoint).length, 0)
    await CouchContinuum.removeCheckpoint()
    checkpoint = await CouchContinuum.getCheckpoint()
    assert.strictEqual(getRemaining(checkpoint).length, allDbs.length)
  })

  it('should handle availability OK', async function () {
    const continuum = new CouchContinuum({ couchUrl, source: dbName })
    let available = await CouchContinuum._isAvailable(continuum.source.href)
    // available by default
    assert.strictEqual(available, true)
    // sets from undefined ok
    await CouchContinuum._setAvailable(continuum.source.href)
    available = await CouchContinuum._isAvailable(continuum.source.href)
    assert.strictEqual(available, true)
    // sets unavailable consecutively ok
    await CouchContinuum._setUnavailable(continuum.source.href)
    available = await CouchContinuum._isAvailable(continuum.source.href)
    assert.strictEqual(available, false)
    await CouchContinuum._setUnavailable(continuum.source.href)
    available = await CouchContinuum._isAvailable(continuum.source.href)
    assert.strictEqual(available, false)
    // sets available consecutively ok
    await CouchContinuum._setAvailable(continuum.source.href)
    available = await CouchContinuum._isAvailable(continuum.source.href)
    assert.strictEqual(available, true)
    await CouchContinuum._setAvailable(continuum.source.href)
    available = await CouchContinuum._isAvailable(continuum.source.href)
    assert.strictEqual(available, true)
  })

  it('should handle remote source and target URLs', function () {
    const source = 'http://localhost:5985/hello-world'
    const target = 'http://localhost:5986/ahoy-planet'
    const continuum = new CouchContinuum({ couchUrl, source, target })
    assert.strictEqual(continuum.source.port, '5985')
    assert.strictEqual(continuum.target.port, '5986')
    // also works with local target
    const localTarget = 'ahoy-planet'
    const continuum2 = new CouchContinuum({ couchUrl, source, target: localTarget })
    assert.strictEqual(continuum2.target.port, continuum2.url.port)
  })

  it('should replicate security OK', async function () {
    const continuum = new CouchContinuum({ couchUrl, source: dbName, replicateSecurity: true })
    const security = { members: { roles: ['hello'], names: ['world'] } }
    await request({
      url: `${couchUrl}/${dbName}/_security`,
      method: 'PUT',
      json: security
    })
    await continuum.createReplica()
    const replicaSec = await request({
      url: `${couchUrl}/temp_copy_${dbName}/_security`,
      json: true
    })
    assert.strictEqual(security.members.roles[0], replicaSec.members.roles[0])
    assert.strictEqual(security.members.names[0], replicaSec.members.names[0])
  })

  it('should run timer code', async function () {
    const interval = 1
    const continuum = new CouchContinuum({
      couchUrl,
      source: dbName,
      interval
    })
    await continuum.createReplica()
  })
})
