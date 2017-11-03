class @FileApi
  self = @
  request = require "request"


  constructor: ()->
    request = require "request"



  getFileContentByteFromUrlPath : (urlPath, callback) ->
    request.get urlPath, (error, response, body) ->
      if !error and response.statusCode is 200
        bodyContent = body
        console.log "Got file content!"
      else
        bodyContent = null
        console.log "Could not get file conten from path #{urlPath}"
      callback null, bodyContent





@fileApi = new @FileApi()
