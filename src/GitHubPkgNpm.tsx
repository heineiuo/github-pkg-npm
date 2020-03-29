/**
 * Copyright (c) 2020-present, heineiuo.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fetch from 'node-fetch'
import os from 'os'
import fs from 'fs'
import path from 'path'
import semver from 'semver'
import gunzip from 'gunzip-maybe'
import stream from 'stream'
import errors from 'http-errors'
import tar from 'tar-stream'

const BASE_URL = `https://npm.pkg.github.com`

interface GitHubPkgNpmOptions {
  scope: string
  token: string
  cacheDir?: string
}

interface ParsedFilename {
  name: string
  version: string
  pkgUrl: string
  filePath: string
}

interface PkgInfo {
  isDistTag: boolean
  data: any
  exactVersion: string
}

interface PkgIndexData {
  data: any
  mtime: number
}

export default class GitHubPkgNpm {
  constructor(opt: GitHubPkgNpmOptions) {
    this.scope = opt.scope
    this.token = opt.token
    this.cacheDir =
      opt.cacheDir || path.resolve(os.tmpdir(), './github-pkg-npm')
  }

  scope: string
  token: string
  cacheDir: string

  getDownloadDir(name: string, exactVersion: string): string {
    const folder = path.resolve(this.cacheDir, 'files', name, exactVersion)
    return folder
  }

  async ensureFolder(folder: string): Promise<string> {
    try {
      await fs.promises.access(folder, fs.constants.W_OK)
      return folder
    } catch (e) {
      if (e.code === 'ENOENT') {
        try {
          await fs.promises.mkdir(folder, { recursive: true })
          return folder
        } catch (e) {
          throw e
        }
      } else {
        throw e
      }
    }
  }

  async fetchPkgData(
    name: string,
    pkgUrl: string,
    version: string
  ): Promise<PkgInfo> {
    let data = await this.fetchPkgIndexData(name, pkgUrl)
    if (!data) throw new Error('Not found')
    if (data.error) {
      if (data.error === 'Not Found') throw new Error('Not found')
      throw new Error(data.error)
    }

    let isDistTag = false

    // console.log(data)

    if (data['dist-tags'][version]) {
      isDistTag = true
      version = data['dist-tags'][version]
      data = data.versions[version]
    } else if (version) {
      if (!data.versions[version]) {
        const versions = Object.keys(data.versions)
        version = semver.maxSatisfying(versions, version)

        if (!version) {
          throw new Error("Version doesn't exist")
        }
      }

      data = data.versions[version]

      if (!data) {
        throw new Error("Version doesn't exist")
      }
    }

    return {
      isDistTag,
      data,
      exactVersion: version,
    }
  }

  async downloadFile(address: string): Promise<string> {
    if (!address) throw new errors.BadRequest('Empty filename')

    const { name, version, pkgUrl, filePath } = this.parseFilename(address)
    // return console.log({ name, version, pkgUrl, filePath })

    if (semver.valid(version)) {
      try {
        const dlDir = this.getDownloadDir(name, version)
        await this.ensureFolder(dlDir)
        const fullFilePath = path.join(dlDir, filePath)
        if (!(fullFilePath.indexOf(dlDir) === 0))
          throw new Error('Forbidden path')
        await fs.promises.stat(fullFilePath)
        return fullFilePath
      } catch (e) {}
    }

    const {
      exactVersion,
      data,
      // isDistTag
    } = await this.fetchPkgData(name, pkgUrl, version)
    const dlDir = this.getDownloadDir(name, exactVersion)

    await this.ensureFolder(dlDir)
    await this.downloadAndExtract(data.dist.tarball, dlDir)
    const fullFilePath = path.join(dlDir, filePath)
    if (!(fullFilePath.indexOf(dlDir) === 0)) throw new errors.Forbidden()
    return fullFilePath
  }

  async testReadFile(filename: string): Promise<string> {
    // console.log(`Result in ${this.getLocalPath(filename)}`)
    await this.downloadFile(filename)
    return await fs.promises.readFile(this.getLocalPath(filename), 'utf8')
  }

  getBasicAuthorization(): string {
    return Buffer.from(`${this.scope}:${this.token}`).toString('base64')
  }

  downloadAndExtract(address: string, dir: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        let res = await fetch(address, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Authorization: `Basic ${this.getBasicAuthorization()}`,
            // Accept:
            // 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
          },
        })

        res = await fetch(res.headers.get('Location'))

        if (!res.ok) {
          // console.log(await res.text())
          // console.log('statusText', res.statusText)
          // console.log('address', address)
          throw new errors[res.status]()
        }

        // return
        const buf = await res.buffer()
        // console.log(buf)
        const bufferStream = new stream.PassThrough()
        const extract = tar.extract()
        extract.on('entry', async (header: any, stream: any, next: any) => {
          const withoutPrefix =
            header.name.indexOf('package') === 0
              ? header.name.substr(7)
              : header.name
          const writePath = path.join(dir, withoutPrefix)
          const folder =
            header.type === 'file' ? path.dirname(writePath) : writePath
          await this.ensureFolder(folder)
          if (header.type === 'file') {
            const ws = fs.createWriteStream(writePath)
            stream.pipe(ws)
          }
          stream.on('end', function() {
            next()
          })
          stream.resume()
        })
        extract.on('finish', function() {
          resolve()
        })
        bufferStream.pipe(gunzip()).pipe(extract)
        bufferStream.end(buf)
      } catch (e) {
        // console.log('fail...')
        reject(e)
      }
    })
  }

  parseFilename(filename: string): ParsedFilename {
    const pathList = filename.split('/').filter(item => !!item)
    if (pathList.length < 2) throw new Error('Invalid filename')
    let nameWithVersion = pathList.shift()
    if (nameWithVersion[0] === '@') nameWithVersion += `/${pathList.shift()}`
    const atList = nameWithVersion.split('@')
    const [name, version] =
      atList.length === 3 ? [`@${atList[1]}`, atList[2]] : atList
    const pkgUrl = `${BASE_URL}/${this.scope}/${encodeURIComponent(
      name
    ).replace(/^%40/, '@')}`
    const filePath = pathList.join('/')
    return { name, version, pkgUrl, filePath }
  }

  getPkgFilePath(name: string): string {
    const file = path.resolve(this.cacheDir, 'index', name, 'index.json')
    return file
  }

  async readCachedPkgIndexData(name: string): Promise<PkgIndexData> {
    try {
      const pkgFilePath = this.getPkgFilePath(name)
      const stat = await fs.promises.stat(pkgFilePath)
      const data = JSON.parse(await fs.promises.readFile(pkgFilePath, 'utf8'))
      return {
        data,
        mtime: stat.mtime.getTime(),
      }
    } catch (e) {
      return {
        data: null,
        mtime: 0,
      }
    }
  }

  async fetchPkgIndexData(
    name: string,
    pkgUrl: string,
    expire = 30000
  ): Promise<any> {
    const pkgFilePath = this.getPkgFilePath(name)
    const pkgIndexData = await this.readCachedPkgIndexData(name)
    if (!pkgIndexData.data || Date.now() > pkgIndexData.mtime + expire) {
      const res = await fetch(pkgUrl, {
        headers: {
          Authorization: `Basic ${this.getBasicAuthorization()}`,
          accept:
            'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
        },
      })
      pkgIndexData.data = await res.json()
      await this.ensureFolder(path.dirname(pkgFilePath))
      await fs.promises.writeFile(
        pkgFilePath,
        JSON.stringify(pkgIndexData.data),
        'utf8'
      )
    }
    return pkgIndexData.data
  }

  getLocalPath(filename: string): string {
    if (!filename) throw new Error('Empty filename')

    const { name, version, filePath } = this.parseFilename(filename)

    if (semver.valid(version)) {
      try {
        const dlDir = this.getDownloadDir(name, version)
        return path.join(dlDir, filePath)
      } catch (e) {}
    }
  }
}
