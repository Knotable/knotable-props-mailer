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



  createDraftEmailEvent: (user_id, type = EmailHelperShared.DRAFT, options = {}) ->
    doc =
      user_id: user_id
      type: type

    doc.campaigns  = options.campaigns  if options.campaigns
    doc.recipients = options.recipients if options.recipients
    doc.from       = options.from       if options.from
    doc.file_ids   = options.file_ids   if options.file_ids
    doc.due_date   = options.due_date   if options.due_date
    doc.subject    = options.subject    if options.subject
    doc.html       = options.html       if options.html
    doc.text       = options.text       if options.text
    doc.tags       = options.tags       if options.tags

    email_event_id = EmailEvents.insert doc
    return email_event_id



  findAllEmailEvent: (user_id) ->
    EmailEvents.find user_id: user_id



  findDraftEmailEvent: (user_id) ->
    EmailEvents.findOne user_id: user_id, type: EmailHelperShared.DRAFT



  removeDraftEmailEvent: (user_id) ->
    EmailEvents.remove {user_id: user_id, type: EmailHelperShared.DRAFT}, {multi: true}



  findAndCreateIfNotExistingDraftEmail: (userId) ->
    check userId, String
    query = type: EmailHelperShared.DRAFT, user_id: userId
    draftEmail = EmailEvents.findOne query, fields: _id: 1
    return draftEmail._id if draftEmail
    unless draftEmail
      return @createDraftEmailEvent(userId, EmailHelperShared.DRAFT)



  maybeCreateDraftEmailForUser: (userId) ->
    Boolean @findAndCreateIfNotExistingDraftEmail(userId)



  updateEmailEvent: (emailData, type = EmailHelperShared.DRAFT, status = EmailHelperShared.IN_QUEUE) ->
    updateData =
      $set:
        from         : emailData.from
        campaigns    : emailData.campaigns
        tags         : emailData.tags
        subject      : emailData.subject
        recipients   : emailData.recipients
        created_time : new Date()
        file_ids     : emailData.file_ids
        due_date     : emailData.due_date
        user_id      : emailData.user_id
        type         : type
        status       : status
        html         : emailServerShared.inlineCssStyle emailData.html
        text         : emailData.text
        is_test      : Boolean emailData.is_test
    updateData.$set.status = status unless emailData.is_test
    EmailEvents.update {_id: emailData._id}, updateData
    console.log "Updated event with _id #{emailData._id}"
    return emailData._id



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



@emailHelperShared = new EmailHelperShared()
