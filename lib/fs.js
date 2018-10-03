const { promisify } = require('util')
const { readFile, unlink, writeFile } = require('fs')

exports.readFile = promisify(readFile)
exports.unlink = promisify(unlink)
exports.writeFile = promisify(writeFile)
