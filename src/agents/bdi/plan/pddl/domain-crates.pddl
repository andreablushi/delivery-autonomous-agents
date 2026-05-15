(define (domain deliveroo-crates)
    (:requirements :strips :typing)
    (:types tile crate)

    (:predicates
        (at ?t - tile)                              ; agent position predicate      
        (adj-up    ?from - tile ?to - tile)      ; adjacenct tiles in the four cardinal directions
        (adj-down  ?from - tile ?to - tile)
        (adj-left  ?from - tile ?to - tile)
        (adj-right ?from - tile ?to - tile)
        (crate-at    ?c - crate ?t - tile); crate position predicate
        (crate-free  ?t - tile)           ; indicates whether a tile is free of crates (i.e. can be moved into or have a crate pushed into it)
        (crate-space ?t - tile)                 ; indicates whether a tile is a valid space for crates (i.e. not a wall or other obstacle, but may or may not currently have a crate on it
    )

    ; Basic movement actions for the agent to move around the grid
    (:action move-up
        :parameters (?from - tile ?to - tile)
        :precondition (and (at ?from) (adj-up ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-down
        :parameters (?from - tile ?to - tile)
        :precondition (and (at ?from) (adj-down ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-left
        :parameters (?from - tile ?to - tile)
        :precondition (and (at ?from) (adj-left ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-right
        :parameters (?from - tile ?to - tile)
        :precondition (and (at ?from) (adj-right ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )

    ; Actions for pushing crates around the grid, which update the agent's position as well as the crate's position
    (:action push-up
        :parameters (?agentFrom - tile ?crateFrom - tile ?crateTo - tile ?c - crate)
        :precondition (and
            (at ?agentFrom)
            (adj-up ?agentFrom ?crateFrom)
            (adj-up ?crateFrom ?crateTo)
            (crate-at ?c ?crateFrom)
            (crate-space ?crateTo)
            (crate-free ?crateTo)
        )
        :effect (and
            (at ?crateFrom) (not (at ?agentFrom))
            (crate-at ?c ?crateTo) (not (crate-at ?c ?crateFrom))
            (crate-free ?crateFrom) (not (crate-free ?crateTo))
        )
    )
    (:action push-down
        :parameters (?agentFrom - tile ?crateFrom - tile ?crateTo - tile ?c - crate)
        :precondition (and
            (at ?agentFrom)
            (adj-down ?agentFrom ?crateFrom)
            (adj-down ?crateFrom ?crateTo)
            (crate-at ?c ?crateFrom)
            (crate-space ?crateTo)
            (crate-free ?crateTo)
        )
        :effect (and
            (at ?crateFrom) (not (at ?agentFrom))
            (crate-at ?c ?crateTo) (not (crate-at ?c ?crateFrom))
            (crate-free ?crateFrom) (not (crate-free ?crateTo))
        )
    )
    (:action push-left
        :parameters (?agentFrom - tile ?crateFrom - tile ?crateTo - tile ?c - crate)
        :precondition (and
            (at ?agentFrom)
            (adj-left ?agentFrom ?crateFrom)
            (adj-left ?crateFrom ?crateTo)
            (crate-at ?c ?crateFrom)
            (crate-space ?crateTo)
            (crate-free ?crateTo)
        )
        :effect (and
            (at ?crateFrom) (not (at ?agentFrom))
            (crate-at ?c ?crateTo) (not (crate-at ?c ?crateFrom))
            (crate-free ?crateFrom) (not (crate-free ?crateTo))
        )
    )
    (:action push-right
        :parameters (?agentFrom - tile ?crateFrom - tile ?crateTo - tile ?c - crate)
        :precondition (and
            (at ?agentFrom)
            (adj-right ?agentFrom ?crateFrom)
            (adj-right ?crateFrom ?crateTo)
            (crate-at ?c ?crateFrom)
            (crate-space ?crateTo)
            (crate-free ?crateTo)
        )
        :effect (and
            (at ?crateFrom) (not (at ?agentFrom))
            (crate-at ?c ?crateTo) (not (crate-at ?c ?crateFrom))
            (crate-free ?crateFrom) (not (crate-free ?crateTo))
        )
    )
)
