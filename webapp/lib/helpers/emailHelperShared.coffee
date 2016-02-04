class @EmailHelperShared
  self = @

  @DRAFT = "DRAFT"
  @ACTIVE = "ACTIVE"
  @IN_QUEUE = "IN_QUEUE"
  @SENT = "SENT"



  createEmailEvent: (from, subject, recipients, campaigns, file_ids, due_date, user_id, type = EmailHelperShared.DRAFT, status = EmailHelperShared.IN_QUEUE) ->
    email_event_id = EmailEvents.insert
      from: from
      recipients: recipients
      campaign: campaigns
      created_time: new Date()
      file_ids: file_ids
      due_date: due_date
      user_id: user_id
      type: type
      status: status
    return email_event_id



  createDraftEmailEvent: (user_id, type = EmailHelperShared.DRAFT) ->
    email_event_id = EmailEvents.insert
      user_id: user_id
      type: type
    return email_event_id


  findAllEmailEvent: (user_id) ->
    EmailEvents.find user_id: user_id

  findDraftEmailEvent: (user_id) ->
    EmailEvents.findOne user_id: user_id, type: EmailHelperShared.DRAFT

  removeDraftEmailEvent: (user_id) ->
    EmailEvents.remove {user_id: user_id, type: EmailHelperShared.DRAFT}, {multi: true}

  findAndCreateIfNotExistingDraftEmail : ->
    draftEmail = EmailEvents.findOne type: EmailHelperShared.DRAFT
    return draftEmail._id if draftEmail
    unless draftEmail
      return @createDraftEmailEvent(Meteor.userId(), EmailHelperShared.DRAFT)


  updateEmailEvent: (emailData, type = EmailHelperShared.DRAFT, status = EmailHelperShared.IN_QUEUE) ->
    updateData =
      $set:
        from: emailData.from
        campaigns: emailData.campaigns
        subject: emailData.subject
        recipients: emailData.recipients
        created_time: new Date()
        file_ids: emailData.file_ids
        due_date: emailData.due_date
        user_id: emailData.user_id
        type: type
        status: status
        is_test: emailData.is_test
    email_event_id = EmailEvents.update {_id: emailData._id}, updateData

    console.log "Updated event with _id #{emailData._id}"
    return email_event_id


  updateDateOfEmailEvent: (email_event_id, new_date) ->
    updateData =
      $set:
        due_date: new_date
    email_event_id = EmailEvents.update {_id: email_event_id}, updateData



  removeEmailEvent: (email_event_id) ->
    Files.remove email_event_id : email_event_id
    EmailEvents.remove _id: email_event_id




  hasCampaignInList : (campaigns, campaignName) ->
    isDefault = false
    for e in campaigns
      if e[campaignName]
        isDefault = true
        break
    return isDefault


  buildEmailList: (recipients, campaigns) ->
    emails = recipients
# Remove this restriction by card#5958 https://trello.com/c/NVuxkN0E/5958-k-mailer-list-management
#    hasKActiveCampaign = _.contains campaigns, DEFAULT_CAMPAIGN.KACTIVE
#    hasKBlogCampaign = _.contains campaigns, DEFAULT_CAMPAIGN.KNOTEBLOG
#    if !hasKActiveCampaign and !hasKBlogCampaign
#      emails = _.filter emails, (e) -> e.lastIndexOf('@knotable.com') is -1

    return _.uniq emails


  buildEmailDataFromEmailEvent : (emailEvent) ->
    return null unless emailEvent
    if ValidationsHelper.validateEmailParams(emailEvent)
      emailData = {}
      emailData.from = emailEvent.from
      emailData.subject = emailEvent.subject
      if emailEvent.is_test
        return null if _.isEmpty emailEvent.recipients
        emailData.to = emailEvent.recipients
        emailData.subject = "[TEST: " +  emailEvent.campaigns.toString() + "] " +  emailEvent.subject
        emailData['o:campaign'] = DEFAULT_CAMPAIGN.KTEST
      else
        emails = @buildEmailList(emailEvent.recipients, emailEvent.campaigns)
        return null if _.isEmpty emails
        emailData.to = emails
        emailData['o:campaign'] = emailEvent.campaigns[0]
      return emailData
    return null




@emailHelperShared = new EmailHelperShared()
