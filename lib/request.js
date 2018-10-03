const request = require('request')

module.exports = async function (options) {
  return new Promise((resolve, reject) => {
    request(options, (err, res, body) => {
      if (err) return reject(err)
      return resolve(body)
    })
  })
}
