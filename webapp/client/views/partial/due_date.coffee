Template.change_due_date_popup.rendered = ->
  currentDate = new Date()
  currentDate.setHours(0,0,0,0)
  $dueTime = $(this.find(".due-time"))
  $dueTime.timepicker
    appendWidgetTo: "body"
    minuteStep: 5
  $dueDate = $(this.find(".due-date-picker"))
  $dueDate.datepicker
    altField: $(this.find(".due-date"))
    minDate: -10
    beforeShowDay: (date) ->
      if (date.getTime() <  currentDate.getTime())
        return [false, "due-date-disabled"]
      else
        return [true, ""]
  if @data
    $dueDate.datepicker 'setDate', @data
    $dueTime.timepicker 'setTime', @data
  else
    next5MinutesTime =  DateHelperShared.from_minutes(new Date(), 5)
    $dueTime.timepicker 'setTime', next5MinutesTime


Template.change_due_date_popup.events
  'click .time-picker .show-time-picker': (e) ->
    $(e.currentTarget).closest('.due-time').timepicker('showWidget')
    $('.choose-absolute').click()



  'focus .due-time': (e) ->
    $(e.currentTarget).closest('.due-time').timepicker('showWidget')
    $('.choose-absolute').click()



  'focus .due-date': (e) -> $('.choose-absolute').click()



  'click input.time-selector': (e, t) ->
    t.$('.time-selector').prop('checked', false)
    $(e.currentTarget).prop('checked', true)



  'click .date-from-now select': (e, t) ->
    $('.choose-relative').click()
