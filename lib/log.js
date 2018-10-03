const { name } = require('../package.json')

module.exports = function () {
  if (process.env.DEBUG || process.env.LOG) {
    console.log(`[${name}]`, ...arguments)
  }
}
