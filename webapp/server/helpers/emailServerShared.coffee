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
    console.info "[sendEmailByEmailEventId called] email_event_id : '#{email_event_id}' ..."
    emailData = EmailEvents.findOne _id : email_event_id
    return unless emailData

    emailData['o:campaign'] = emailData.campaigns[0]
    toEmails = emailData.recipients

    _.each toEmails, (email) ->
      oneEmailData = _.clone(emailData)
      oneEmailData.to = email
      emailServerShared.sendEmailWithCampaign oneEmailData



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
