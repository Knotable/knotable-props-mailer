import MailgunClient from "../mailgunClient"
import inlineCss from "inline-css"
import { defaultDomainConfig, findDomainConfigByDomain } from "../mailgunDomains"

class @EmailServerShared
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
      'message'
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



  sendEmailByEmailEventId: (email_event_id) ->
    console.info "[sendEmailByEmailEventId called] email_event_id : '#{email_event_id}' ..."
    emailData = EmailEvents.findOne _id : email_event_id
    if !emailData or !emailData.html
      console.info "Not sending email because it has no content: _id: '#{emailData._id}'"
      msg = "Your email \"#{emailData.subject}\", scheduled to be sent at #{moment(emailData.due_date).format("h:mm a, DD/MM/YY")}, was not sent because it has no content"
      { domain } = defaultDomainConfig
      @sendEmail(domain, {
        to: emailData.from
        from: "Kmail<donotreply@#{domain}>",
        due_date: new Date(),
        subject: "ALERT from #{domain}",
        text: msg
      })
      return

    data = emailHelperShared.parseMailAddress(emailData.from)
    { domain } = findDomainConfigByDomain(data.domain)
    emailData = @addCampaignsAndTags emailData
    toEmails = emailData.recipients
    results = {}
    AsyncHelper.each _.uniq(toEmails), (email) =>
      oneEmailData = _.clone(emailData)
      oneEmailData.to = email
      try
        results[email] = @sendEmail(domain, oneEmailData)
      catch err
        console.error '[sendEmailByEmailEventId] Failed to send message to', email, err
        results[email] = false
    console.log "[sendEmailByEmailEventId] result", results
    _.any _.values(results), (value) -> value



  sendEmail: (domain, emailData) ->
    emailData = _.pick emailData, @allowedMessageFields()
    console.info "Sending to #{emailData.to} \"#{emailData.subject}\". domain: #{domain}"
    try
      return Promise.await(MailgunClient.messages.create(domain, emailData))
    catch err
      console.error(err)


  sendTestEmail: (emailData) ->
    emailData.to = [ emailData.from ]
    emailData = @addCampaignsAndTags emailData
    data = emailHelperShared.parseMailAddress(emailData.from)
    { domain } = findDomainConfigByDomain(data.domain)
    emailData.from = "Kmail Test<donotreply@#{domain}>"
    result = @sendEmail domain, emailData
    console.log(result)


  addCampaignsAndTags: (emailData) ->
    console.log emailData
    { campaigns, tags } = emailData
    emailData['o:campaign'] = campaigns unless _.isEmpty campaigns
    emailData['o:tag'] = _.first tags, 3 unless _.isEmpty tags
    emailData



  inlineCssStyle: (html) ->
    Promise.await(inlineCss(html, { url: ' ' }))



@emailServerShared = new EmailServerShared()
