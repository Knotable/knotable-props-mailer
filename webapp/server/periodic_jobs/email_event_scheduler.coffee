# 1. Find active event_emails which has in queue status and has due_date equals to current_time
# 2. Sent email and update status to SENT

class EmailEventScheduler

  constructor: ->


  _findEmailEventInQueue = ->
    currentDate = new Date()
    query =
      status : EmailHelperShared.IN_QUEUE
      type: EmailHelperShared.ACTIVE
      due_date:
        $gt: moment(currentDate).subtract(1, 'minutes').toDate()
        $lte: currentDate
    return EmailEvents.find(query).fetch()



  _doProcessing = =>
    console.info "[Email scheduler] begin processing..."
    try
      emailEvents = _findEmailEventInQueue()
      if emailEvents and emailEvents.length
        console.info "FOUND ", emailEvents.length, " emails should be sent"
        AsyncHelper.each emailEvents, (e) ->
          eventId = e._id
          try
            if emailServerShared.sendEmailByEmailEventId eventId
              EmailEvents.update {_id: eventId}, {$set : {status: EmailHelperShared.SENT}}
          catch err
            console.log error
            console.log error.stack if error.stack
    catch e
      console.error "[Email scheduler] failed when processing email:", e
      console.error e.stack if e.stack
    console.info "[Email scheduler] ended processing"



  _delay = -> 
    moment().add(1, 'minutes').set('seconds', 0) - moment()



  job: =>
    Meteor.setTimeout -> 
      _doProcessing()
      emailEventScheduler.job()
    , _delay()


@emailEventScheduler = new EmailEventScheduler()

Meteor.startup ->
  console.log "Starting email event scheduler..."
  emailEventScheduler.job()
  console.log "Started email event scheduler"