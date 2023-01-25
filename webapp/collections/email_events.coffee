# Store email event, support email reminder
@EmailEvents= new Meteor.Collection 'email_events'



@EmailEvents.allow
  insert: (userId, doc) ->
    true

  update: (userId, doc, fieldNames, modifier) ->
    true

  remove: (userId, doc) ->
    true


if Meteor.isServer 
  EmailEvents.createIndex({
    user_id: 1,
  })
