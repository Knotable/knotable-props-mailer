class @EmailServerShared
  self = @
  Fiber = Meteor.npmRequire('fibers')
  Future = Meteor.npmRequire('fibers/future')



  getFileFromS3Url: (url) ->
    waitForFile = new Future()
    file = null
    fileApi.getFileContentByteFromUrlPath url, (error, result) ->
      file = result
      waitForFile.return()
    waitForFile.wait()
    return file



  sendEmailByEmailEventId: (email_event_id) ->
    try
      console.info "[sendEmailByEmailEventId called] email_event_id : '#{email_event_id}' ..."
      emailEvent = EmailEvents.findOne _id : email_event_id
      emailData = emailHelperShared.buildEmailDataFromEmailEvent(emailEvent)
      return unless emailData

      htmlFile = null
      emailData.text = emailEvent.htmlText


      fileIds = emailEvent.file_ids
      files = Files.find({_id: {$in : fileIds}}).fetch()
      _.each files, (file) ->
        if FileHelper.HTML_TYPE is file.extension
          htmlFile = file
      async.waterfall [
        (callback) ->
          if htmlFile
            fileApi.getFileContentByteFromUrlPath htmlFile.s3_url, (error, bodyContent) ->
              emailData.html = bodyContent
              callback null
          else
            callback null
        (callback) ->
          body = emailData.html || emailData.text
          unless body
            return callback "Invalid body content"
          console.log "emailData:", emailData, "; emailEvent:", emailEvent
          Fiber ->
            toEmails = emailData.to
            _.each toEmails, (email) ->
              oneEmailData = _.clone(emailData)
              oneEmailData.to = email
              emailServerShared.sendEmailWithCampaign oneEmailData
          .run()
          callback null
      ], (err, result) ->
        console.warn "[ERROR] Failed to send email: " + err if err
      return true
    catch error
      console.error error if error
    return false



  sendEmailWithCampaign: (emailData) ->
    mailgunApiUrl = "#{Meteor.settings.mailgun.api_base_url}/messages"
    console.log "Sending email with campaign. MailgunApiUrl: #{mailgunApiUrl}"
    waitForEmailResult = new Future()
    emailResult = null
    Meteor.http.post mailgunApiUrl, {
        auth: 'api:' + Meteor.settings.mailgun.api_key
        params: emailData
      }, (error, result) ->
        emailResult = error || result
        waitForEmailResult.return()
    waitForEmailResult.wait()
    return emailResult



@emailServerShared = new EmailServerShared()
