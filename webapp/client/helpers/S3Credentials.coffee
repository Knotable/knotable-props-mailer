class @S3Credentials
  constructor: ->
    Session.set 's3credentials', {}



  requestCredentials: ->
    Meteor.call 'requestCredentials', (err, credentials) =>
      if err
        console.error("S3Credentials.requestCredentials - requestCredentials method returned error: ", err)
        Session.set 's3credentials', {}
      else
        console.log('S3Credentials.requestCredentials - got new S3 credentials:', credentials)
        credentials.obtained = true
        Session.set 's3credentials', credentials
        @scheduleRefresh(credentials.refreshTimeoutMilliseconds)



  getCredentials: ->
    Session.get 's3credentials'




  areReady: ->
    Session.get('s3credentials').obtained



  scheduleRefresh: (timeout) ->
    if timeout
      console.log('S3Credentials.scheduleRefresh - scheduling credentials refresh in', timeout, 'ms')
      Meteor.setTimeout =>
        @requestCredentials()
      , timeout



@S3Credentials = new @S3Credentials()
