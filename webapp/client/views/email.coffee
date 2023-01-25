import { ReactiveVar } from "meteor/reactive-var"



getParsedEmail = (store) ->
  from = store.currentDraft({ from: 1 })?.from
  if from
    return emailHelperShared.parseMailAddress(from)
  return null



getCurrentDomain = (domains, storedDomain) ->
  getDefaultDomain = -> domains.find((d) -> d.isDefault)?.domain
  if storedDomain
    domains.find((d) -> d.domain is storedDomain)?.domain or getDefaultDomain()
  else
    getDefaultDomain()



Template.new_email.onCreated ->
  @domains = new ReactiveVar([])
  @senderName = new ReactiveVar("")
  @emailLocalPart = new ReactiveVar("")
  @currentDomain = new ReactiveVar("")
  @autorun =>
    return unless Meteor.userId()
    @store = new LocalDataStore "drafts.user_#{Meteor.userId()}.draftEmails"
    @store.currentDraft = (options) -> @findOne EmailViewerHelper.currentEmailEventId(), options
    Meteor.call("getDomains",(err, domains) =>
      data = getParsedEmail(@store)
      @domains.set(domains)
      @senderName.set(data.name) if data?.name
      @emailLocalPart.set(data.localPart) if data?.localPart
      @currentDomain.set(getCurrentDomain(domains, data?.domain))
    )



Template.new_email.onDestroyed ->
  @store?.unmount()
  delete @store



Template.new_email.onRendered ->
  $el = $('#email-edit')
  $el.summernote('destroy')
  $el.summernote
    placeholder: 'Write your message here...'
    toolbar: [
      ['style', ['bold', 'italic', 'underline', 'clear']],
      ['insert', ['link', 'table', 'hr']],
      ['font', ['strikethrough', 'superscript', 'subscript']],
      ['fontsize', ['fontsize']],
      ['color', ['color']],
      ['para', ['ul', 'ol', 'paragraph']],
      ['height', ['height']],
      ['misc', ['fullscreen', 'codeview', 'undo', 'redo', 'help']]
      ['mybutton', ['uploadFile']]
    ]
    buttons:
      uploadFile: UploadButton
    callbacks:
      onChange: =>
        content = $el.summernote 'code'
        @store.update EmailViewerHelper.currentEmailEventId(), $set: html: content

      onImageUpload: (files) ->
        async.each files, (file, next) ->
          EmailViewerHelper.uploadContentImage file, (err, url) ->
            unless err
              img = document.createElement 'img'
              img.alt = img.title = file.name
              img.style.display = 'block'
              img.src = url
              $el.summernote 'insertNode', img
            next()

  @autorun =>
    if event = EmailEvents.findOne(EmailViewerHelper.currentEmailEventId(), reactive: false)
      @store.insert event unless @store.findOne event._id, fields: _id: 1
      $el.summernote 'code', @store.currentDraft(reactive: false).html
      saveChangesToServerEvery moment.duration(5, 'seconds'), @store



saveChangesToServerEvery = (duration, store) ->
  currentDraftId = EmailViewerHelper.currentEmailEventId()
  fields = from: 1, subject: 1, html: 1, recipients: 1, campaigns: 1, tags: 1
  delayedSaveId = null
  lastSavedDocument = EmailEvents.findOne currentDraftId, { fields, reactive: false }

  delaySave = (id) ->
    Meteor.clearTimeout delayedSaveId if delayedSaveId
    delayedSaveId = Meteor.setTimeout ->
      document = store.findOne id, { fields }
      if document and not EJSON.equals(document, lastSavedDocument)
        lastSavedDocument = document
        Session.set 'autoSaving', 'pending'
        console.log 'Saving...'
        Meteor.call 'updateDraftEmail', document, (err) ->
          Session.set 'autoSaving', err and 'failed' or 'success'
          console.log 'Saved', err and 'failed' or 'success'
    , duration.asMilliseconds()

  cursor = Tracker.nonreactive -> store.find currentDraftId, { fields }
  observer = cursor.observeChanges
    changed: delaySave
    removed: -> Meteor.clearTimeout delayedSaveId if delayedSaveId
  if Tracker.currentComputation
    Tracker.currentComputation.onInvalidate -> observer.stop()
  delaySave currentDraftId



Template.new_email.helpers
  hasUploadedFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      false
    plainTextfile = Files.findOne email_event_id: eventId, extension: FileHelper.PLAIN_TEXT_TYPE
    htmlfile = Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE
    return true if plainTextfile and htmlfile
    return false


  domains: ->
    Template.instance().domains.get().map((d) -> d.domain)


  senderName: ->
    Template.instance().senderName.get()


  emailLocalPart: ->
    Template.instance().emailLocalPart.get()


  currentDomain: ->
    Template.instance().currentDomain.get()



  from: ->
    fields = from: 1
    Template.instance().store.currentDraft({ fields })?.from


  subject: ->
    fields = subject: 1
    Template.instance().store.currentDraft({ fields })?.subject


  recipients: ->
    fields = recipients: 1
    Template.instance().store.currentDraft({ fields })?.recipients


  campaigns: ->
    fields = campaigns: 1
    Template.instance().store.currentDraft({ fields })?.campaigns


  tags: ->
    fields = tags: 1
    Template.instance().store.currentDraft({ fields })?.tags


  htmlFile: ->
    eventId = EmailViewerHelper.currentEmailEventId()
    unless eventId
      return false
    Files.findOne email_event_id: eventId, extension: FileHelper.HTML_TYPE



updateFieldContent = (name, validator, store) ->
  validator.validate (err) ->
    store.update EmailViewerHelper.currentEmailEventId(), $set: "#{name}": validator.getValue() unless err



Template.new_email.events
  'change #sender_name': (e, t) ->
    { from } = EmailViewerHelper.getValidators()
    updateFieldContent 'from', from, t.store



  'change #from_address': (e, t) ->
    { from } = EmailViewerHelper.getValidators()
    updateFieldContent 'from', from, t.store



  'click .from-address-group .dropdown-menu a': (e, t) ->
    e.preventDefault()
    t.currentDomain.set(e.target.dataset.id)
    store = t.store
    Tracker.afterFlush ->
      { from } = EmailViewerHelper.getValidators()
      updateFieldContent 'from', from, store



  'change #subject': (e, t) ->
    { subject } = EmailViewerHelper.getValidators()
    updateFieldContent 'subject', subject, t.store



  'change #recipients': (e, t) ->
    { recipients } = EmailViewerHelper.getValidators()
    updateFieldContent 'recipients', recipients, t.store



  'change #campaigns': (e, t) ->
    { campaigns } = EmailViewerHelper.getValidators()
    updateFieldContent 'campaigns', campaigns, t.store



  'change #tags': (e, t) ->
    { tags } = EmailViewerHelper.getValidators()
    updateFieldContent 'tags', tags, t.store



  'click .btn-send': (e, t) ->
    e.stopPropagation()
    $ele = $(e.currentTarget)
    $form = $ele.closest('.email-container')
    $(".input-error").removeClass 'input-error'
    $('.btn-send', $form).attr('disabled', 'disabled')
    emailId = EmailViewerHelper.currentEmailEventId()
    EmailViewerHelper.sendEmail $form, (err, result) ->
      $('.btn-send', $form).removeAttr('disabled')
      if err
        { selector } = err.details or {}
        showErrorBootstrapGrowl err.reason
        $(selector, $form).addClass('input-error').focus() if selector
      else
        t.store.remove emailId
        $('a[data-tab-index="1"]').click()
        showBootstrapGrowl("Added email in queue")



  'click .btn-test-send': (e) ->
    e.stopPropagation()
    $ele = $(e.currentTarget)
    originalText = $ele.text()
    $ele.text('Sending')
    $form = $ele.closest('.email-container')
    $(".input-error").removeClass 'input-error'
    EmailViewerHelper.sendTestEmail $form, (err, result) ->
      $ele.text(originalText)
      if err
        { selector } = err.details or {}
        showErrorBootstrapGrowl err.reason
        $(selector, $form).addClass('input-error').focus() if selector
      else
        showBootstrapGrowl result



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
  $form.find('.event-plain-text').val('')



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
    query =
      status: EmailHelperShared.SENT
      type: EmailHelperShared.ACTIVE
    email_sent_events = EmailEvents.find(query, {sort: {due_date: -1 }}).fetch()
    return email_sent_events



Template.email_box.helpers
  plainTextFile : ->
    file = Files.findOne email_event_id : @_id, extension: FileHelper.PLAIN_TEXT_TYPE
    return false unless file
    return file

  htmlFile : ->
    file = Files.findOne @file_ids?[0]
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
    self =  @
    EmailViewerHelper.resetDraftEmailEvent()
    Meteor.defer ->
      EmailViewerHelper.makeNewFromQueuedOne self



Template.file_attachment_box.helpers
  file_ext: ->
    dotIndex = @name.lastIndexOf(".")
    if(dotIndex>=0)
      file_ext = @name.substr(dotIndex+1).toLowerCase()
    else
      file_ext = ""
    file_ext


Template.sent_email_box.helpers
  displayDate: (date) ->
    moment(date).format("MMM D YYYY, h:m A")


  joinArray: (array) ->
    return array.join(', ')


  file: ->
    Files.findOne(@file_ids?[0])


