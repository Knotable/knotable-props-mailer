Template.new_email.helpers
  hasUploadedFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      false
    plainTextfile = Files.findOne email_event_id: eventId, extension: FileHelper.PLAIN_TEXT_TYPE
    htmlfile = Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE
    return true if plainTextfile and htmlfile
    return false



  draftEvent: ->
    EmailEvents.findOne _id : EmailViewerHelper.currentEmailEventId()



Template.new_email.events
  'click .btn-send': (e) ->
    e.stopPropagation()
    $ele = $(e.currentTarget)

    $form = $ele.closest('.email-container')
    hasTesting = $form.find('.test-email').prop('checked')
    emailData = EmailViewerHelper.getEmailInfoFromForm($form)
    return unless emailData

    unless hasTesting
      isOk = confirm "Are you sure you're ready to send?"
      return unless isOk
    $ele.attr('disabled', 'disabled')

    Meteor.call "updateEmailEvent", emailData, EmailHelperShared.ACTIVE, EmailHelperShared.IN_QUEUE, (err, result) ->
      unless err
        EmailViewerHelper.afterAddingToQueue(emailData)
        showBootstrapGrowl("Added email in queue")
      else
        showErrorBootstrapGrowl("Error when adding email in queue")
      $ele.removeAttr('disabled')



  "click .reset": (e) ->
    $ele = $(e.currentTarget)
    $form = $ele.closest('.email-container')
    EmailViewerHelper.resetDraftEmailEvent()
    reset_new_email_event_form $form





reset_new_email_event_form = ($form) ->
  $form.find("input[type=text]").val("")
  $dueTime = $form.find(".due-time")
  $dueDate =$form.find(".due-date-picker")
  next5MinutesTime =  DateHelperShared.from_minutes(new Date(), 5)
  $dueDate.datepicker 'setDate', next5MinutesTime
  $dueTime.timepicker 'setTime', next5MinutesTime
  $form.find('.test-email').removeAttr('checked')



Template.email_list.helpers
  email_events : ->
    currentDate = new Date()
    query =
      status : EmailHelperShared.IN_QUEUE
      type: EmailHelperShared.ACTIVE
      due_date:
        $gte : currentDate
    email_events = EmailEvents.find(query).fetch()
    return email_events



Template.sent_email_list.helpers
  sent_email_events : ->
    currentDate = new Date()
    query =
      status: EmailHelperShared.SENT
      type: EmailHelperShared.ACTIVE
      due_date:
        $lte: currentDate
    email_sent_events = EmailEvents.find(query).fetch()
    return email_sent_events



Template.email_box.helpers
  plainTextFile : ->
    file = Files.findOne email_event_id : @_id, extension: FileHelper.PLAIN_TEXT_TYPE
    return false unless file
    return file

  htmlFile : ->
    file = Files.findOne email_event_id : @_id, extension: FileHelper.HTML_TYPE
    return false unless file
    return file



  date: ->
    return moment(@due_date).format("MMM D YYYY, h:m A")



  timeFromNow: ->
    timeTick.depend()
    return DateHelperShared.getCountDown @due_date



Template.email_box.events
  'click .email-box-badge-delete': (e) ->
    eventId = $(e.currentTarget).data("id")
    isOk = confirm("Do you really want to delete it?")
    if isOk and eventId
      Meteor.call "removeEmailEvent", eventId, (e, result) ->
        if e
          console.log e
        else
          console.log "Removed email_event with id #{eventId} "



  'click .edit-email-event': (e) ->
    $form = $(e.target).closest('.email-box').find('.email-box-change-date')
    EmailViewerHelper.toggleDateTimeBoxInEmailBox($form)



  'click .save-update-date': (e) ->
    $form = $(e.target).closest('.email-box')
    $changeDateForm = $form.find('.email-box-change-date')
    if eventDate = EmailViewerHelper.validDateTimeInEmailBox($changeDateForm)
      eventId = $form.data("id")
      emailHelperShared.updateDateOfEmailEvent eventId, eventDate
      EmailViewerHelper.toggleDateTimeBoxInEmailBox($changeDateForm)



  'click .cancel-update-date': (e) ->
    $form = $(e.target).closest('.email-box').find('.email-box-change-date')
    EmailViewerHelper.toggleDateTimeBoxInEmailBox($form)


  'click .make-new': ->
    EmailViewerHelper.makeNewFromQueuedOne @



Template.file_attachment_box.helpers
  file_ext: ->
    dotIndex = @name.lastIndexOf(".")
    if(dotIndex>=0)
      file_ext = @name.substr(dotIndex+1).toLowerCase()
    else
      file_ext = ""
    file_ext
