Meteor.startup ->
  @timeTick = new Tracker.Dependency()

  Meteor.setInterval ->
    timeTick.changed()
  , 1000
