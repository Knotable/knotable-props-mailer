@EmailViewerHelper =
  sendEmail: ($form, $button, test) ->

    file = EmailViewerHelper.getHtmlFile()
    if !file then return showErrorBootstrapGrowl "Please upload a html file, or save one using the editor."
    self = @

    Meteor.call 'getFileFromS3Url', file.s3_url, (error, html) ->

      uploadRequest = "Please upload a html file, or save one using the editor."
      if error then return showErrorBootstrapGrowl("There was a problem retriving the html file. " + uploadRequest)
      if not jQuery(html).text() then return showErrorBootstrapGrowl("Your email has no content. " + uploadRequest)

      emailData = {}

      $fromAddress = $form.find("#from_address")
      unless self.isCorrectEmailAddressWithRealName $fromAddress, "Incorrect From email"
        return
      emailData.from =  $fromAddress.val().trim()

      $subject = $form.find("#subject")
      unless emailData.subject = self.hasEmpty $subject, "Please input Subject"
        return

      $recipients = $form.find("#recipients")
      emailData.recipients = self.validRecipients($recipients)
      return unless emailData.recipients
      if test
        for r in emailData.recipients
          if r.match( /(props|knotable)/ )
            return showErrorBootstrapGrowl "Looks like you're trying to send a test email to a mailing list.
                                            You can only send test emails to personal addresses."
        emailData.to = emailData.recipients

      $campaigns = $form.find("#campaigns")
      if test
        emailData.campaigns = self.getEmailListOrCampaignFromString($campaigns.val().trim())
      else
        emailData.campaigns = self.validCampaign($campaigns)
        return unless emailData.campaigns

      eventId = self.currentEmailEventId()
      emailData.file_ids = []

      emailData.text = jQuery(html).text()
      emailData.html = html

      if test
        eventDate = new Date
        emailData.to = emailData.recipients
      else
        if $('.choose-absolute').prop('checked')
          $dueDate =  $form.find(".due-date")
          return unless date = self.isValidDate($dueDate, "Invalid Date")
          $dueTime =  $form.find(".due-time")
          return unless time = self.isValidTime $dueTime, "Invalid Time"
          eventDate = new Date(date + " " + time)
          return showErrorBootstrapGrowl "Please select a time greater than 2 minutes from now." if moment() > moment(eventDate).subtract(2, 'minutes')
        else
          $ele = $('.date-from-now')
          minutes = $ele.find('select[name=Minutes]').val()
          hours = $ele.find('select[name=Hours]').val()
          days = $ele.find('select[name=Days]').val()
          newDate = moment().add
            minutes: minutes
            hours: hours
            days: days
          eventDate = newDate.toDate()

      emailData.due_date = eventDate
      emailData._id = self.currentEmailEventId()
      emailData.user_id = Meteor.userId()
      emailData.file_ids.push file._id

      if test
        Meteor.call 'sendTestEmail', emailData, (e, result) ->
          if e
            showErrorBootstrapGrowl e
          else
            $button.text('Test sent')
      else
        $('.btn-send').attr('disabled', 'disabled')
        EmailViewerHelper.addToQueue emailData


  getHtmlFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    Files.findOne email_event_id: eventId



  displayHtmlInEditor: ->
    file = @getHtmlFile()
    if file
      Meteor.call 'getFileFromS3Url', file.s3_url, (error, html) ->
        $('#email-edit').summernote('code', html)



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



  currentEmailEventId: -> Session.get "CURRENT_DRAFT_EVENT_ID"



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



  validCampaign: ($campaigns) ->
    $campaigns.removeClass("input-error")
    campaigns = @getEmailListOrCampaignFromString($campaigns.val().trim())
    if !campaigns or campaigns.length is 0
      $campaigns.addClass("input-error")
      $campaigns.focus()
      showErrorBootstrapGrowl "Please input the campaign Id"
      return null
    isValid = true
    for e in campaigns
      unless e
        $campaigns.addClass("input-error")
        $campaigns.focus()
        showErrorBootstrapGrowl "Incorrect campaign '#{e}' in Campaign "
        isValid = false
        break
    return null unless isValid
    return campaigns



  addToQueue: (emailData) ->
    Meteor.call "updateEmailEvent", emailData, EmailHelperShared.ACTIVE, EmailHelperShared.IN_QUEUE, (err, result) ->
      unless err
        EmailViewerHelper.afterAddToQueue emailData
        showBootstrapGrowl("Added email in queue")
        $('a[href="#tab-queued"]').click()
      else
        showErrorBootstrapGrowl("Error when adding email in queue")
      $('.btn-send').removeAttr('disabled')



  # Add new draft EmailEvent
  # Copy content from old ones including file
  afterAddToQueue: (emailData) ->
    draftId = emailHelperShared.createDraftEmailEvent Meteor.userId(), EmailHelperShared.DRAFT,
      campaigns  : emailData.campaigns
      recipients : emailData.recipients
      from       : emailData.from
      due_date   : emailData.due_date
      subject    : emailData.subject
      html       : emailData.html
      text       : emailData.text

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
          html       : ""
          text       : ""
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
        html       : emailData.html
        text       : emailData.text
