# Meteor.publish "fileByEmailEventId", (email_event_id) ->
#   if @userId
#     return Files.find {email_event_id: email_event_id}
#   return []


Meteor.publish "emailEventsAndFiles", ->
  if @userId
    emailHelperShared.maybeCreateDraftEmailForUser @userId
    findQuery =
      user_id : @userId
      status:
        $ne: EmailHelperShared.SENT
      $or: [
        {type : EmailHelperShared.DRAFT}
        {type : EmailHelperShared.ACTIVE, due_date: {$gte: new Date()}}
      ]
    emailEventCursor = EmailEvents.find(findQuery)
    eventIds = emailEventCursor.map (event) -> event._id
    eventIds = _.uniq(eventIds)
    fileCursor = Files.find {email_event_id: {$in: eventIds}}
    return [emailEventCursor, fileCursor]
  return []


Meteor.publish "sentEmailEventsAndFiles", ->
  if @userId
    findQuery =
      user_id : @userId
      status: EmailHelperShared.SENT
      type : EmailHelperShared.ACTIVE
    option =
      limit: 40

    emailEventCursor = EmailEvents.find(findQuery, option)
    eventIds = emailEventCursor.map (event) -> event._id
    eventIds = _.uniq(eventIds)
    fileCursor = Files.find {email_event_id: {$in: eventIds}}
    return [emailEventCursor, fileCursor]
  return []


Meteor.publish "mailingList", () ->
  if @userId
    return MailingList.find {}
  return []
