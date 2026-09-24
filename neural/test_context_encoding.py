"""Board-level context selection regression tests; no PyTorch required."""

import unittest

from neural.encoding import encode_position


def position(*snapshots, action=0, even=False):
    """Build sparse raw timeline slots from (slot, half-turn, piece count)."""
    board = [None] * (max(line for line, _, _ in snapshots) + 1)
    if not even:
        board[0] = []
    for line, time, pieces in snapshots:
        if board[line] is None:
            board[line] = []
        board[line].extend([None] * (time + 1 - len(board[line])))
        board[line][time] = [[2] * pieces] if pieces else [[0]]
    return {"board": board, "action": action}


def retained_boards(encoded):
    return [tuple(coordinate[:2])
            for category, coordinate in zip(encoded.categories, encoded.coordinates)
            if category[0] == 1]


class ContextSelectionTests(unittest.TestCase):
    def test_distance_uses_signed_timeline_not_storage_slot(self):
        # Slot 3 (-2L) is adjacent to slot 1 (-1L). Slot 2 (+1L) is farther.
        source = position((1, 4, 5), (2, 3, 5), (3, 3, 5))
        encoded = encode_position(source, 16)
        self.assertEqual(retained_boards(encoded), [(-1, 4), (-2, 3)])
        self.assertEqual(encoded.context["tokens"], 13)

    def test_even_timelines_have_adjacent_distinct_zero_timelines(self):
        # -0L and +0L are adjacent. Both candidates are equally distant;
        # the newer +0L board must win the tie against -1L.
        source = position((1, 4, 5), (2, 5, 5), (3, 3, 5), even=True)
        encoded = encode_position(source, 16)
        self.assertEqual(retained_boards(encoded), [(-1, 4), (0, 5)])
        self.assertEqual(encoded.global_features[6], 1)

    def test_distance_uses_nearest_of_multiple_playable_frontiers(self):
        source = position((0, 18, 5), (0, 20, 5), (2, 3, 5), (2, 4, 5))
        encoded = encode_position(source, 20)
        # An older board near the second frontier beats a newer distant one.
        # Retained tokens still follow canonical storage order, not distance.
        self.assertEqual(retained_boards(encoded), [(0, 20), (1, 3), (1, 4)])
        self.assertFalse(encoded.context["frontierTruncated"])
        self.assertEqual(encoded, encode_position(source, 20))

    def test_temporal_distance_counts_full_turns(self):
        source = position((0, 2, 5), (0, 4, 5), (2, 3, 5))
        encoded = encode_position(source, 16)
        # Two half-turns on the same timeline are closer than crossing one
        # timeline and one half-turn, despite the second candidate being newer.
        self.assertEqual(retained_boards(encoded), [(0, 2), (0, 4)])

    def test_black_action_uses_black_frontier_as_anchor(self):
        source = position((0, 4, 5), (0, 5, 5), (2, 2, 5), action=1)
        encoded = encode_position(source, 16)
        self.assertEqual(retained_boards(encoded), [(0, 4), (0, 5)])

    def test_inactive_future_boards_remain_playable_anchors(self):
        # With no negative timelines, +4L (slot 8) is inactive in the rules.
        source = position((0, 3, 5), (0, 4, 5), (8, 39, 5), (8, 40, 5))
        encoded = encode_position(source, 20)
        self.assertEqual(retained_boards(encoded), [(0, 4), (4, 39), (4, 40)])
        self.assertFalse(encoded.context["frontierTruncated"])

    def test_no_playable_frontier_falls_back_to_all_latest_boards(self):
        source = position((0, 4, 5), (0, 5, 5), (2, 0, 5), (2, 3, 5))
        encoded = encode_position(source, 20)
        self.assertEqual(retained_boards(encoded), [(0, 4), (0, 5), (1, 3)])
        self.assertFalse(encoded.context["frontierTruncated"])

    def test_remote_opponent_frontier_omission_is_reported(self):
        source = position((0, 2, 5), (0, 3, 5), (0, 4, 5), (8, 1, 5))
        encoded = encode_position(source, 20)
        # Both frontiers would fit together, but closer history wins priority.
        self.assertEqual(retained_boards(encoded), [(0, 2), (0, 3), (0, 4)])
        self.assertTrue(encoded.context["frontierTruncated"])
        self.assertEqual(encoded.global_features[7], 1)
        self.assertTrue(encoded.context["truncated"])
        self.assertEqual(encoded.context["tokens"], 19)

    def test_oversized_closer_board_stops_selection_of_farther_boards(self):
        source = position((0, 2, 1), (0, 3, 10), (0, 4, 5))
        encoded = encode_position(source, 16)
        # Nine tokens remain after the frontier. The next board needs eleven;
        # its farther two-token neighbor must not be selected in its place.
        self.assertEqual(retained_boards(encoded), [(0, 4)])
        self.assertEqual(encoded.context["tokens"], 7)
        self.assertEqual(encoded.context["totalTokens"], 20)
        self.assertTrue(encoded.context["truncated"])
        self.assertFalse(encoded.context["frontierTruncated"])
        self.assertEqual(sum(category[0] == 2 for category in encoded.categories), 5)

    def test_equal_distance_prefers_newer_then_signed_timeline(self):
        for positive_time, retained in ((5, [(0, 4), (1, 5)]),
                                        (3, [(0, 4), (-1, 3)])):
            with self.subTest(positive_time=positive_time):
                source = position((0, 4, 5), (1, 3, 5), (2, positive_time, 5))
                encoded = encode_position(source, 16)
                self.assertEqual(retained_boards(encoded), retained)


if __name__ == "__main__":
    unittest.main()
