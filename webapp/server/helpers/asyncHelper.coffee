Fiber = require 'fibers'



@AsyncHelper =

  ###
  Simple wrap of async.waterfall method which executes methods with the only one parameter is a callback function
  ###
  execWaterfall: (fnArray, cb) ->
    wrapFnArray = _.map fnArray, (fn) ->
      Meteor.bindEnvironment () ->
        fnCallback = _.find arguments, (_argument) ->
          _.isFunction _argument
        fn.call this, fnCallback
    async.waterfall wrapFnArray, cb



  wait: (momentDuration) ->
    fiber = Fiber.current
    Meteor.setTimeout TimeoutProxy(identifier: 'AsyncHelper#wait', ->
      fiber.run()
    ), momentDuration.asMilliseconds()
    Fiber.yield()
