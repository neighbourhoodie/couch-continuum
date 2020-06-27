const request = require('request')

module.exports = async function (options) {
  return new Promise((resolve, reject) => {
    request(options, (err, res, body) => {
      if (err) return reject(err)
      if (res.statusCode >= 400) {
        let string, json
        if (typeof body === 'string') {
          string = body
          json = { options, ...JSON.parse(body) }
        } else {
          string = JSON.stringify(body)
          json = { options, ...body }
        }
        const error = new Error(string)
        Object.entries(json).map(([prop, value]) => {
          error[prop] = value
        })
        return reject(error)
      } else {
        return resolve(body)
      }
    })
  })
}
