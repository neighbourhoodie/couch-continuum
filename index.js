const assert = require('assert').strict
const path = require('path')
const ProgressBar = require('progress')
const { URL, format: urlFormat } = require('url')

const log = require('./lib/log')
const request = require('./lib/request')
const { name } = require('./package.json')
const { readFile, unlink, writeFile } = require('./lib/fs')

const checkpoint = path.join(__dirname, '.checkpoint')

const TEMP_COPY_SUFFIX = 'temp_copy_'

const urlParse = (url) => {
  try {
    return new URL(url)
  } catch (error) {
    if (/^Invalid URL/.test(error.message)) {
      // path fragment, not url
      return { pathname: url }
    } else {
      throw error
    }
  }
}

const displayUrl = (url) => {
  return url.host + url.pathname
}

module.exports =
class CouchContinuum {
  static async allDbs (url) {
    const allDbs = await request({ url: `${url}/_all_dbs`, json: true })
    return allDbs.filter((dbName) => {
      const isSpecial = (dbName[0] === '_') // ignore special dbs
      const isReplica = dbName.indexOf(TEMP_COPY_SUFFIX) > -1
      return !isSpecial && !isReplica
    })
  }

  /**
   * Check the checkpoint file for an in-progress run
   * against a particular CouchDB cluster.
   * @return {Array<String>}  List of databases still to be migrated.
   */
  static async getCheckpoint () {
    return readFile(checkpoint, 'utf-8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '\u0000'
      } else {
        throw error
      }
    })
  }

  static async makeCheckpoint (dbName) {
    await writeFile(checkpoint, dbName, 'utf-8')
  }

  static async removeCheckpoint () {
    try {
      await unlink(checkpoint)
    } catch (error) {
      // don't complain if checkpoint is already missing
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  static async getRemaining (couchUrl) {
    const dbNames = await CouchContinuum.allDbs(couchUrl)
    const lastDb = await CouchContinuum.getCheckpoint()
    // ignore any databases that sort lower than
    // the name in the checkpoint doc.
    return dbNames.filter((dbName) => { return dbName > lastDb })
  }

  static async createReplicas (continuums) {
    for (const continuum of continuums) {
      await continuum.createReplica()
    }
  }

  static async replacePrimaries (continuums) {
    for (const continuum of continuums) {
      await continuum.replacePrimary()
      await CouchContinuum.makeCheckpoint(continuum.source.pathname.slice(1))
    }
    await CouchContinuum.removeCheckpoint()
  }

  static async _isAvailable (dbUrl) {
    try {
      const { down } = await request({
        url: `${dbUrl}/_local/in-maintenance`,
        json: true
      })
      return !down
    } catch (error) {
      if (error.error !== 'not_found') {
        throw error
      } else {
        // document doesn't exist, so, db must be available
        return true
      }
    }
  }

  static async _setUnavailable (dbUrl) {
    const url = `${dbUrl}/_local/in-maintenance`
    try {
      // update
      const { _rev: rev } = await request({ url, json: true })
      return request({ url, json: { _rev: rev, down: true }, method: 'PUT' })
    } catch (error) {
      if (error.error === 'not_found') {
        // create
        await request({ url, method: 'PUT', json: { down: true } })
      } else {
        throw error
      }
    }
  }

  static async _setAvailable (dbUrl) {
    const url = `${dbUrl}/_local/in-maintenance`
    try {
      const { _rev: rev } = await request({ url, json: true })
      return request({ url, qs: { rev }, method: 'DELETE' })
    } catch (error) {
      if (error.error === 'not_found') {
        // already available, nothing to do
        return null
      } else {
        throw error
      }
    }
  }

  constructor ({
    couchUrl,
    filterTombstones,
    interval,
    n,
    placement,
    q,
    replicateSecurity,
    source,
    target,
    allowReplications,
    continuous
  }) {
    assert(couchUrl, 'The Continuum requires a URL for accessing CouchDB.')
    assert(source, 'The Continuum requires a source database.')
    this.url = urlParse(couchUrl)
    // get source url
    const parsedSource = urlParse(source)
    if (parsedSource.host) {
      this.source = parsedSource
    } else {
      this.source = urlParse(`${this.url.href}${encodeURIComponent(source)}`)
    }
    // get target url
    if (target) {
      const parsedTarget = urlParse(target)
      if (parsedTarget.host) {
        this.target = parsedTarget
      } else {
        this.target = urlParse(`${this.url.href}${encodeURIComponent(target)}`)
      }
    } else {
      const tmpTarget = urlParse(this.source)
      const tmpTargetNoLeadingSlash = tmpTarget.pathname.substr(1)
      tmpTarget.pathname = `${TEMP_COPY_SUFFIX}${tmpTargetNoLeadingSlash}`
      this.target = urlParse(urlFormat(tmpTarget))
    }
    // save other variables
    this.interval = interval || 1000
    this.q = q
    this.n = n
    this.placement = placement
    this.filterTombstones = filterTombstones
    this.replicateSecurity = replicateSecurity
    this.allowReplications = allowReplications
    this.continuous = continuous
    // what's great for a snack and fits on your back
    // it's log it's log it's log
    // everyone wants a log
    log(`Created new continuum: ${JSON.stringify({
      filterTombstones: this.filterTombstones,
      interval: this.interval,
      n: this.n,
      placement: this.placement,
      q: this.q,
      replicateSecurity: this.replicateSecurity,
      source: `${displayUrl(this.source)}`,
      target: `${displayUrl(this.target)}`,
      url: this.url.host
    }, undefined, 2)}`)
  }

  async _createDb (dbUrl) {
    const qs = {}
    if (this.q) { qs.q = this.q }
    if (this.n) { qs.n = this.n }
    if (this.placement) { qs.placement = this.placement }
    try {
      const result = await request({
        url: dbUrl,
        method: 'PUT',
        qs,
        json: true
      })
      return result
    } catch (error) {
      if (error.error !== 'file_exists') {
        throw error
      }
    }
  }

  async _destroyDb (dbUrl) {
    return request({
      url: dbUrl,
      method: 'DELETE',
      json: true
    })
  }

  async _replicate (source, target, selector) {
    const result = await request({ url: source.href, json: true })
    const { doc_count: total } = result
    if (total === 0) return null
    console.log(`[${name}] Replicating ${target.host}${source.pathname} to ${target.host}${target.pathname}`)
    const text = `[${name}] (:bar) :percent :etas`
    const bar = new ProgressBar(text, {
      incomplete: ' ',
      width: 20,
      total
    })
    var current = 0
    const timer = setInterval(async () => {
      try {
        const { doc_count: latest } = await request({
          url: target.href,
          json: true
        })
        const delta = latest - current
        bar.tick(delta)
        current = latest
        if (bar.complete) clearInterval(timer)
      } catch (e) {
        clearInterval(timer)
        throw e
      }
    }, this.interval)
    await request({
      url: `${this.url.href}_replicate`,
      method: 'POST',
      json: { source: source.href, target: target.href, selector }
    })
    await this._waitForCompletion({ source, target })
    // copy security object over
    if (this.replicateSecurity) {
      log(`Replicating ${source}/_security to ${target}...`)
      const security = await request({
        url: `${this.source.href}/_security`,
        json: true
      })
      await request({
        url: `${this.target.href}/_security`,
        method: 'PUT',
        json: security
      })
    }
    bar.tick(total)
    clearInterval(timer)
  }

  async _waitForCompletion ({ source, target }) {
    const srcName = `/${source.pathname.slice(1)}/`
    const tgtName = `/${target.pathname.slice(1)}/`

    const isUs = (task) => {
      return task.source?.includes(srcName) &&
             task.target?.includes(tgtName) &&
             task.missing_revisions_found > task.docs_written
    }

    while (true) {
      const tasks = await request({
        url: `${this.url.href}_active_tasks`,
        json: true
      })
      if (tasks.some(isUs)) {
        await this._sleep(1000)
      } else {
        return
      }
    }
  }

  _sleep (msecs) {
    return new Promise((resolve) => setTimeout(resolve, msecs))
  }

  async _verifyReplica () {
    const { doc_count: docCount1 } = await request({
      url: this.source.href,
      json: true
    })
    const { doc_count: docCount2 } = await request({
      url: this.target.href,
      json: true
    })
    assert.strictEqual(docCount1, docCount2, 'Primary and replica do not have the same number of documents.')
  }

  /**
   * Retrieve the update sequence for a given database.
   * @param  {String} dbName  Name of the database to check.
   * @return {String}         The database's update sequence.
   */
  async _getUpdateSeq (dbUrl) {
    const { update_seq: updateSeq } = await request({ url: dbUrl, json: true })
    return updateSeq
  }

  /**
   * Check if a database is still receiving updates or is
   * otherwise being monitored.
   * @param  {String}  dbName     Name of the database to check.
   * @return {Boolean}            Whether the database is in use.
   */
  async _isInUse (dbName) {
    // TODO check all known hosts
    try {
      const activeTasks = await request({
        url: `${this.url.href}_active_tasks`,
        json: true
      })
      const { jobs } = await request({
        url: `${this.url.href}_scheduler/jobs`,
        json: true
      }).then(({ jobs }) => {
        return { jobs: jobs || [] }
      })
      for (const { database, source, target } of [...jobs, ...activeTasks]) {
        const re = new RegExp(`/${dbName}/`)
        if (database) {
          assert.strictEqual(re.test(database), true)
        }
        assert.strictEqual(re.test(source), true)
        assert.strictEqual(re.test(target), true)
      }
    } catch (error) {
      if (error.error === 'illegal_database_name') {
        // 1.x -- this block is just for travis' test conditions
        return null
      } else {
        throw error
      }
    }
  }

  /**
   * Create a replica for the migration.
   * @return {Promise} Promise that resolves once
   *                   the replica has been created
   */
  async createReplica () {
    log(`Creating replica ${displayUrl(this.target)}...`)
    log('[0/5] Checking if primary is in use...')
    if (this.allowReplications) {
      log('Skipping check because replications are allowed')
    } else {
      await this._isInUse(this.source.pathname.slice(1))
    }
    const lastSeq1 = await this._getUpdateSeq(this.source.href)
    log(`[1/5] Creating replica db: ${displayUrl(this.target)}`)
    await this._createDb(this.target.href)
    log('[2/5] Beginning replication of primary to replica...')
    const selector = this.filterTombstones ? {
      _deleted: { $exists: false }
    } : undefined
    await this._replicate(this.source, this.target, selector)
    if (this.continuous) {
      log(`Setting up continuous replication from ${this.source} to ${this.target}...`)
      await request({
        url: `${this.url.href}_replicate`,
        method: 'POST',
        json: { source: this.source.href, target: this.target.href, continuous: true }
      })
    }
    log('[3/5] Verifying primary did not change during replication...')
    const lastSeq2 = await this._getUpdateSeq(this.source.href)
    assert(lastSeq1 <= lastSeq2, `${displayUrl(this.source)} is still receiving updates. Exiting...`)
    log('[4/5] Verifying primary and replica match...')
    await this._verifyReplica()
    log('[5/5] Primary copied to replica.')
  }

  async replacePrimary () {
    log(`Replacing primary ${displayUrl(this.source)} using ${displayUrl(this.target)}...`)
    log('[0/8] Checking if primary is in use...')
    if (this.allowReplications) {
      log('Skipping check because replications are allowed')
    } else {
      await this._isInUse(this.source.pathname.slice(1))
    }
    log('[1/8] Verifying primary and replica match...')
    await this._verifyReplica()
    log('[2/8] Destroying primary...')
    await this._destroyDb(this.source.href)
    log('[3/8] Recreating primary with new settings...')
    await this._createDb(this.source.href)
    await new Promise((resolve) => {
      // sleep, giving the cluster a chance to sort
      // out the rapid recreation.
      console.log(`[${name}] Recreating primary ${displayUrl(this.source)}`)
      const text = `[${name}] (:bar) :percent :etas`
      const bar = new ProgressBar(text, {
        incomplete: ' ',
        width: 20,
        total: 150
      })
      const timer = setInterval(() => {
        bar.tick()
        if (bar.complete) {
          clearInterval(timer)
          return resolve()
        }
      }, 100)
    })
    log('[4/8] Setting primary to unavailable.')
    await CouchContinuum._setUnavailable(this.source.href)
    log('[5/8] Beginning replication of replica to primary...')
    await this._replicate(this.target, this.source)
    log('[6/8] Replicated. Destroying replica...')
    await this._destroyDb(this.target.href)
    log('[7/8] Setting primary to available.')
    await CouchContinuum._setAvailable(this.source.href)
    log('[8/8] Primary migrated to new settings.')
  }
}
