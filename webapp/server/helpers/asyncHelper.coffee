Fiber = require 'fibers'



@AsyncHelper =

  ###
  Simple wrap of async.waterfall method which executes methods with the only one parameter is a callback function
  ###
  execWaterfall: (fnArray, cb) ->
    wrapFnArray = _.map fnArray, (fn) ->
      Meteor.bindEnvironment ->
        fnCallback = _.find arguments, (_argument) ->
          _.isFunction _argument
        fn.call @, fnCallback
    async.waterfall wrapFnArray, cb



  wait: (momentDuration) ->
    fiber = Fiber.current
    Meteor.setTimeout TimeoutProxy(identifier: 'AsyncHelper#wait', ->
      fiber.run()
    ), momentDuration.asMilliseconds()
    Fiber.yield()



  map: (items, iterator) ->
    return [] if _.isEmpty items
    internalIterator = (item, callback) ->
      Meteor.defer Meteor.bindEnvironment ->
        try
          callback null, iterator item
        catch err
          callback err
    fiber = Fiber.current
    async.map items, internalIterator, (err, mappedItems) ->
      fiber.throwInto err if err
      fiber.run mappedItems
    Fiber.yield()



  each: (items, iterator) ->
    AsyncHelper.map items, iterator
    items
