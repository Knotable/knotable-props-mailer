class @EmailServerShared
  self = @
  Fiber = require 'fibers'
  Future = require 'fibers/future'



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
    results = {}
    AsyncHelper.each _.uniq(toEmails), (email) ->
      oneEmailData = _.clone(emailData)
      oneEmailData.to = email
      try
        results[email] = emailServerShared.sendEmail oneEmailData
      catch err
        console.error '[sendEmailByEmailEventId] Failed to send message to', email, err
        results[email] = false
    console.log "[sendEmailByEmailEventId] result", results
    _.any _.values(results), (value) -> value



  sendEmail: (emailData) ->
    console.info "Sending to #{emailData.to} \"#{emailData.subject}\""
    result = HTTP.post "#{Meteor.settings.mailgun.api_base_url}/messages",
      auth: 'api:' + Meteor.settings.mailgun.api_key
      params: emailData
    result.data


  sendTestEmail: (emailData, includeCampaignsAndTags) ->
    emailData.to = emailData.from
    if includeCampaignsAndTags
      emailData = @addCampaignsAndTags emailData
    @sendEmail emailData


  addCampaignsAndTags: (emailData) ->
    console.log emailData
    { campaigns, tags } = emailData
    emailData['o:campaign'] = campaigns[0] unless _.isEmpty campaigns
    emailData['o:tag'] = tags[0] unless _.isEmpty tags
    emailData



@emailServerShared = new EmailServerShared()
