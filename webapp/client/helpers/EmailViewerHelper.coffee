@EmailViewerHelper =
  getEmailInfoFromForm: ($form) ->
    emailData = {}

    $fromAddress = $form.find("#from_address")
    unless @isCorrectEmailAddressWithRealName $fromAddress, "Incorrect From email"
      return
    emailData.from =  $fromAddress.val().trim()

    $subject = $form.find("#subject")
    unless emailData.subject = @hasEmpty $subject, "Please input Subject"
      return

    $recipients = $form.find("#recipients")
    emailData.recipients = @validRecipients($recipients)
    unless emailData.recipients
      return

    $compaigns = $form.find("#compaigns")
    emailData.campaigns = @validCampaign($compaigns)
    unless emailData.campaigns
      return

    eventId = @currentEmailEventId()
    emailData.file_ids = []

    emailData.htmlText = $form.find('.event-plain-text').val().trim()
    unless emailData.htmlText
      showErrorBootstrapGrowl "Plain text required."
      return

    $dueDate =  $form.find(".due-date")
    unless date = @isValidDate($dueDate, "Invalid Date")
      return


    $dueTime =  $form.find(".due-time")
    unless time = @isValidTime $dueTime, "Invalid Time"
      return

    eventDate = new Date(date + " " + time)
    currentTime = new Date()
    next2MinutesLate = DateHelperShared.from_minutes(currentTime, 2)

    if eventDate.getTime() < next2MinutesLate.getTime()
      showErrorBootstrapGrowl "Please select time which is after 2 minutes from now."
      return

    hasTesting = $form.find('.test-email').prop('checked')
    emailData.is_test = Boolean hasTesting

    emailData.due_date = eventDate
    emailData._id = @currentEmailEventId()
    emailData.user_id = Meteor.userId()

    htmlFile = Files.findOne email_event_id: eventId, extension : FileHelper.HTML_TYPE
    unless htmlFile
      isOk = confirm "Are you sure you want to send a plaintext email?"
      unless isOk
        return
    else
      emailData.file_ids.push htmlFile._id

    return emailData

  hasEmpty: ($element, msg) ->
    value = $element.val().trim()
    unless value
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
    else
      $element.removeClass("input-error")
    return value

  isCorrectEmailAddress: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.isCorrectEmail(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value

  isCorrectEmailAddressWithRealName: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.isCorrectEmailWithRealName(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value

  isValidDate: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.isValidDate(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value

  isValidTime: ($element, msg) ->
    value = $element.val().trim()
    unless ValidationsHelper.checkAndGetValidTimeFromInput(value)
      $element.addClass("input-error")
      $element.focus()
      showErrorBootstrapGrowl msg
      value = null
    else
      $element.removeClass("input-error")
    return value


  currentEmailEventId: ->
    return Session.get "CURRENT_DRAFT_EVENT_ID"

  currentEmailEvent: ->
    eventId = @currentEmailEventId()
    if eventId
      emailEvent = EmailEvents.findOne _id : eventId
      return emailEvent
    return {}

  validDateTimeInEmailBox: ($form) ->
    $dueDate =  $form.find(".due-date")
    unless date = @isValidDate($dueDate, "Invalid Date")
      return null

    $dueTime =  $form.find(".due-time")
    unless time = @isValidTime $dueTime, "Invalid Time"
      return null
    eventDate = new Date(date + " " + time)
    currentTime = new Date()
    next2MinutesLate = DateHelperShared.from_minutes(currentTime, 2)

    if eventDate.getTime() < next2MinutesLate.getTime()
      $dueDate.addClass "input-error"
      showErrorBootstrapGrowl "Please select time which is after 2 minutes from now."
      return null
    return eventDate


  toggleDateTimeBoxInEmailBox: ($form) ->
    $form.toggleClass('hidden')

  findAndCreateNotExistingEmailEvent: ->
    Meteor.call "findAndCreateIfNotExistingDraftEmail", (e, eventId) ->
      if e
        console.log "Failed to findAndCreateIfNotExistingDraftEmail:", e
      else
        Session.set "CURRENT_DRAFT_EVENT_ID", eventId

  getEmailListOrCampaignFromString: (emailString) ->
    unless emailString
      return null
    emails = emailString.replace( /\n/g, " " ).split(/[ ,]+/)
    return _.uniq emails

  validRecipients: ($recipients) ->
    $recipients.removeClass("input-error")
    emails = @getEmailListOrCampaignFromString($recipients.val().trim())
    if !emails or emails.length is 0
      $recipients.addClass("input-error")
      $recipients.focus()
      showErrorBootstrapGrowl "Input emails which separated by commas or spaces in Recipients"
      return null
    isValid = true
    for e in emails
      unless ValidationsHelper.isCorrectEmail(e)
        $recipients.addClass("input-error")
        $recipients.focus()
        showErrorBootstrapGrowl "Incorrect email '#{e}' in Recipients "
        isValid = false
        break
    return null unless isValid
    return emails

  validCampaign: ($compaigns) ->
    $compaigns.removeClass("input-error")
    campaigns = @getEmailListOrCampaignFromString($compaigns.val().trim())
    if !campaigns or campaigns.length is 0
      $compaigns.addClass("input-error")
      $compaigns.focus()
      showErrorBootstrapGrowl "Please input the campaign Id"
      return null
    isValid = true
    for e in campaigns
      unless e
        $compaigns.addClass("input-error")
        $compaigns.focus()
        showErrorBootstrapGrowl "Incorrect campaign '#{e}' in Campaign "
        isValid = false
        break
    return null unless isValid
    return campaigns



  # Add new draft EmailEvent
  # Copy content from old ones including file
  afterAddingToQueue: (emailData) ->
    draftId = emailHelperShared.createDraftEmailEvent Meteor.userId(), EmailHelperShared.DRAFT,
      campaigns  : emailData.campaigns
      recipients : emailData.recipients
      from       : emailData.from
      due_date   : emailData.due_date
      subject    : emailData.subject
      htmlText   : emailData.htmlText

    newFileIds = []
    Files.find({_id: $in: emailData.file_ids}).forEach (file) ->
      delete file._id
      file.email_event_id = draftId
      file.created_time   = new Date()
      fileId = Files.insert file
      newFileIds.push fileId

    EmailEvents.update {_id: draftId}, {$set:{file_ids: newFileIds}}
    Meteor.subscribe "fileByEmailEventId", draftId
    Session.set "CURRENT_DRAFT_EVENT_ID", draftId



  resetDraftEmailEvent: ->
    Tracker.nonreactive ->
      EmailEventId = Session.get("CURRENT_DRAFT_EVENT_ID")
      fileIds = EmailEvents.findOne(EmailEventId).file_ids
      fileIds = _.union fileIds, Files.find({email_event_id: EmailEventId}).map (file) -> file._id
      EmailEvents.update {_id: EmailEventId},
        $unset:
          file_ids   : ""
          campaigns  : ""
          recipients : ""
          from       : ""
          subject    : ""
          htmlText   : ""
      fileIds?.forEach (id) ->
        Files.remove {_id: id}



  # 1. Set status to EmailHelperShared.SENT
  # 2. Update Draft EmailEvent with new Data
  # 3. Update existing files or add new
  makeNewFromQueuedOne: (emailData) ->
    EmailEvents.update {_id: emailData._id}, {$set : {status: EmailHelperShared.SENT}}

    draftId = EmailViewerHelper.currentEmailEventId()
    newFileIds = []

    # Remove old files of draft email event
    Files.find({email_event_id: draftId}).forEach (file) ->
      Files.remove {_id: file._id}

    # Add new Files from Queued one
    Files.find({_id: $in: emailData.file_ids}).forEach (file) ->
      delete file._id
      file.email_event_id = draftId
      file.created_time   = new Date()
      fileId = Files.insert file
      newFileIds.push fileId

    console.log "GC - ", emailData
    EmailEvents.update {_id: draftId},
      $set:
        campaigns  : emailData.campaigns
        recipients : emailData.recipients
        from       : emailData.from
        subject    : emailData.subject
        due_date   : emailData.due_date
        file_ids   : newFileIds
        htmlText   : emailData.htmlText
