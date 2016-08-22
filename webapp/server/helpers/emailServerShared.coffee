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



  sendEmailByEmailEventId: (email_event_id, isTest) ->
    console.info "[sendEmailByEmailEventId called] email_event_id : '#{email_event_id}' ..."
    emailData = EmailEvents.findOne _id : email_event_id
    if !emailData or !emailData.html
      console.info "Not sending email because it has no content: _id: '#{emailData._id}'"
      msg = "Your email \"#{emailData.subject}\", scheduled to be sent at #{moment(emailData.due_date).format("h:mm a, DD/MM/YY")}, was not sent because it has no content"
      emailServerShared.sendEmail {
        to: emailData.from
        from: 'server@props.knotable.com',
        due_date: new Date(),
        subject: "ALERT from props.knotable.com",
        text: msg
      }
      return

    emailData = @addCampaignsAndTags emailData

    toEmails = emailData.recipients

    _.each toEmails, (email) ->
      oneEmailData = _.clone(emailData)
      oneEmailData.to = email
      emailServerShared.sendEmail oneEmailData



  sendEmail: (emailData) ->
    mailgunApiUrl = "#{Meteor.settings.mailgun.api_base_url}/messages"
    console.info "Sending email \"#{emailData.title}\""
    waitForEmailResult = new Future()
    emailResult = null
    Meteor.http.post mailgunApiUrl, {
        auth: 'api:' + Meteor.settings.mailgun.api_key
        params: emailData
      }, (error, result) ->
        emailResult = error || result
        console.log emailResult
        waitForEmailResult.return()
    waitForEmailResult.wait()
    return emailResult


  sendTestEmail: (emailData, includeCampaignsAndTags) ->
    if includeCampaignsAndTags
      emailData = @addCampaignsAndTags emailData
    @sendEmail emailData


  addCampaignsAndTags: (emailData) ->
    console.log emailData
    emailData['o:campaign'] = emailData.campaigns[0]
    emailData['o:tag'] = emailData.tags[0]
    emailData



@emailServerShared = new EmailServerShared()
