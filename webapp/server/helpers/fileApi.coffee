import request from "request"

class @FileApi
  getFileContentByteFromUrlPath : (urlPath) ->
    new Promise((resolve, reject) ->
      request.get urlPath, (error, response, body) ->
        if !error and response.statusCode is 200
          console.log "Got file content!"
          resolve(body)
        else
          console.log "Could not get file content from path #{urlPath}"
          reject(error)
    )



@fileApi = new @FileApi()
