class @EmailServerShared
  formUrlEncoded = require 'form-urlencoded'
  inlineCss = require 'inline-css'



  allowedMessageFields: ->
    # Docs: https://documentation.mailgun.com/en/latest/api-sending.html#sending
    [
      'from'
      'to'
      'cc'
      'bcc'
      'subject'
      'text'
      'html'
      'attachment'
      'inline'
      'o:tag'
      'o:dkim'
      'o:deliverytime'
      'o:testmode'
      'o:tracking'
      'o:tracking-clicks'
      'o:tracking-opens'
      'o:require-tls'
      'o:skip-verification'
      'h:X-My-Header'
      'v:my-var'
      'o:campaign' #Deprecated
    ]



  getFileFromS3Url: (url) ->
    Promise.await(
      fileApi.getFileContentByteFromUrlPath(url)
    )



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
    emailData = _.pick emailData, @allowedMessageFields()
    console.info "Sending to #{emailData.to} \"#{emailData.subject}\""
    result = HTTP.post "#{Meteor.settings.mailgun.api_base_url}/messages",
      auth: 'api:' + Meteor.settings.mailgun.api_key
      headers: 'Content-Type': 'application/x-www-form-urlencoded'
      content: formUrlEncoded emailData
    result.data


  sendTestEmail: (emailData) ->
    emailData.to = [ emailData.from ]
    emailData = @addCampaignsAndTags emailData
    @sendEmail emailData


  addCampaignsAndTags: (emailData) ->
    console.log emailData
    { campaigns, tags } = emailData
    emailData['o:campaign'] = campaigns unless _.isEmpty campaigns
    emailData['o:tag'] = _.first tags, 3 unless _.isEmpty tags
    emailData



  inlineCssStyle: (html) ->
    Promise.await(inlineCss(html, { url: ' ' }))



@emailServerShared = new EmailServerShared()
