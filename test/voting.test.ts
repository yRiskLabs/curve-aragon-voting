import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  increase,
  restoreSnapshot,
  takeSnapshot,
} from "../helpers/rpc";
import {
  ACL,
  ExecutionTarget,
  Kernel,
  MiniMeToken,
  Voting,
} from "../typechain";
import {
  ANY_ENTITY,
  encodeCallScript,
  getEventArgument,
  installNewApp,
  newDao,
  ONE_MINUTE,
  pct16,
  toDecimals,
  ZERO_ADDRESS,
} from "./helpers";

const { utils } = ethers;

describe("Voting", function () {
  let signers: SignerWithAddress[];
  let root: SignerWithAddress;
  let voteCreator: SignerWithAddress;
  let voter: SignerWithAddress;
  let dao: Kernel;
  let acl: ACL;
  let votingBase: Voting;
  let voting: Voting;
  let token: MiniMeToken;
  let executionTarget: ExecutionTarget;
  const appId = utils.namehash("crv-voting.open.aragonpm.eth");

  // Initialization params
  const supportRequired = pct16(50);
  const minAcceptQuorum = pct16(20);
  const voteTime = 10 * ONE_MINUTE;
  const minTime = 10 * ONE_MINUTE;
  const minBalance = 1;
  const minBalanceLowerLimit = 1;
  const minBalanceUpperLimit = 10;
  const minTimeLowerLimit = 5 * ONE_MINUTE;
  const mintTimeUpperLimit = 15 * ONE_MINUTE;

  let snapshotId: string;

  const useSnapshot = async (): Promise<void> => {
    await restoreSnapshot(snapshotId);

    snapshotId = await takeSnapshot();
  };

  before("Set up DAO", async () => {
    signers = await ethers.getSigners();
    [root, voteCreator, voter] = signers;

    [dao, acl] = await newDao(root);
  });

  before("Install Voting", async () => {
    const Voting = await ethers.getContractFactory("Voting");
    votingBase = (await Voting.deploy()) as Voting;
    const votingAddress = await installNewApp(dao, appId, votingBase.address);
    voting = (await ethers.getContractAt(
      "Voting",
      votingAddress,
      root
    )) as Voting;

    const CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE();
    await acl.createPermission(
      ANY_ENTITY,
      voting.address,
      CREATE_VOTES_ROLE,
      root.address
    );
  });

  before("Initialize Voting", async () => {
    const MiniMeToken = await ethers.getContractFactory("MiniMeToken");
    const tokenDecimals = 18;
    token = (await MiniMeToken.deploy(
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      0,
      "Test Token",
      tokenDecimals,
      "TT",
      true
    )) as MiniMeToken;

    await token.generateTokens(
      voteCreator.address,
      toDecimals(10, tokenDecimals)
    );
    await token.generateTokens(voter.address, toDecimals(10, tokenDecimals));

    await voting.initialize(
      token.address,
      supportRequired,
      minAcceptQuorum,
      voteTime,
      minBalance,
      minTime,
      minBalanceLowerLimit,
      minBalanceUpperLimit,
      minTimeLowerLimit,
      mintTimeUpperLimit
    );

    const ExecutionTarget = await ethers.getContractFactory("ExecutionTarget");
    executionTarget = (await ExecutionTarget.deploy()) as ExecutionTarget;

    snapshotId = await takeSnapshot();
  });

  describe("when creating a vote", () => {
    let voteCreatorVoting: Voting;

    let voteId: BigNumber;

    beforeEach("Create vote", async () => {
      await useSnapshot();

      voteCreatorVoting = voting.connect(voteCreator);

      const action = {
        to: executionTarget.address,
        data: executionTarget.interface.encodeFunctionData("execute"),
      };

      // Create a first vote to run following tests with a non-zero voteId
      await voteCreatorVoting["newVote(bytes,string)"](
        encodeCallScript([action]),
        ""
      );
      await increase(voteTime.toString());

      const receipt = await voteCreatorVoting["newVote(bytes,string)"](
        encodeCallScript([action]),
        ""
      );

      voteId = await getEventArgument(
        voting,
        receipt.hash,
        "StartVote",
        "voteId"
      );
    });

    describe("when canceling a vote", () => {
      const reason = utils.id("incorrect proposal target");
      let guardian: Voting;
      let role: string;
      let close: number;

      beforeEach(async () => {
        guardian = voting.connect(signers[3]);
        role = await voting.CANCEL_VOTE_ROLE();
        await acl.createPermission(signers[3].address, voting.address, role, root.address);
        close = (await voting.getVote(voteId)).startDate.toNumber() + voteTime;
      });

      it("closes only the canceled vote and preserves its ballots and script", async () => {
        const before = await voting.getVote(voteId);
        await expect(voting.cancelVote(voteId, reason)).to.be.revertedWith("APP_AUTH_FAILED");
        await expect(guardian.cancelVote(await voting.votesLength(), reason)).to.be.revertedWith("VOTING_NO_VOTE");
        await expect(guardian.cancelVote(voteId, reason))
          .to.emit(voting, "CancelVote").withArgs(voteId, signers[3].address, reason);
        const after = await voting.getVote(voteId);
        expect(after.open).to.equal(false);
        expect(after.executed).to.equal(false);
        expect(after.yea).to.equal(before.yea);
        expect(after.nay).to.equal(before.nay);
        expect(after.script).to.equal(before.script);
        expect(await voting.isVoteCanceled(voteId)).to.equal(true);
        expect(await voting.canVote(voteId, voter.address)).to.equal(false);
        await expect(guardian.cancelVote(voteId, reason)).to.be.revertedWith("VOTING_VOTE_NOT_OPEN");
        await expect(voting.connect(voter).vote(voteId, true, true)).to.be.revertedWith("VOTING_CAN_NOT_VOTE");
        await expect(voting.connect(voter).votePct(voteId, pct16(100), 0, true)).to.be.revertedWith("VOTING_CAN_NOT_VOTE");
        await increase(voteTime.toString());
        expect(await voting.canExecute(voteId)).to.equal(false);
        await expect(voting.executeVote(voteId)).to.be.revertedWith("VOTING_CAN_NOT_EXECUTE");
        expect(await executionTarget.counter()).to.equal(0);
        await voting.executeVote(0);
        expect(await executionTarget.counter()).to.equal(1);
      });

      it("allows cancellation one second before close even with unanimous snapshot support", async () => {
        await voting.connect(voter).vote(voteId, true, true);
        await ethers.provider.send("evm_setNextBlockTimestamp", [close - 1]);
        await guardian.cancelVote(voteId, reason);
        await increase("1");
        expect(await voting.canExecute(voteId)).to.equal(false);
        await expect(voting.executeVote(voteId)).to.be.revertedWith("VOTING_CAN_NOT_EXECUTE");
      });

      it("ends the veto at the exact closing timestamp and allows execution", async () => {
        await ethers.provider.send("evm_setNextBlockTimestamp", [close]);
        await expect(guardian.cancelVote(voteId, reason, { gasLimit: 500000 })).to.be.revertedWith("VOTING_VOTE_NOT_OPEN");
        expect((await ethers.provider.getBlock("latest")).timestamp).to.equal(close);
        expect(await voting.canExecute(voteId)).to.equal(true);
        await voting.executeVote(voteId);
        await expect(guardian.cancelVote(voteId, reason)).to.be.revertedWith("VOTING_VOTE_NOT_OPEN");
      });

      it("honors a first eligible ID and an expiring grant on the Aragon ACL", async () => {
        const first = await voting.votesLength();
        const expiry = close - 100;
        // ACL packs [parameter ID:8 | operator:8 | value:240]. AND combines rules 1 and 2.
        const param = (id: number, op: number, value: BigNumber | number) =>
          BigNumber.from(id).shl(248).or(BigNumber.from(op).shl(240)).or(value);
        await acl.grantPermissionP(signers[3].address, voting.address, role, [
          param(204, 9, BigNumber.from(2).shl(32).or(1)), // AND
          param(0, 5, first), // voteId >= first
          param(201, 4, expiry), // block.timestamp < expiry
        ]);
        await expect(guardian.cancelVote(voteId, reason)).to.be.revertedWith("APP_AUTH_FAILED");
        await voting.connect(voter)["newVote(bytes,string)"]("0x00000001", "");
        await guardian.callStatic.cancelVote(first, reason);
        await ethers.provider.send("evm_setNextBlockTimestamp", [expiry]);
        await expect(guardian.cancelVote(first, reason, { gasLimit: 500000 })).to.be.revertedWith("APP_AUTH_FAILED");
        expect((await voting.getVote(first)).open).to.equal(true);
      });
    });

    describe("when casting a vote", () => {
      let voterVoting: Voting;

      let voterStake: BigNumber;

      const votePct = (pct: number | string): BigNumber =>
        BigNumber.from(pct16(pct));

      const encodeVoteData = (
        voteId: BigNumber,
        yeaPct: BigNumber,
        nayPct: BigNumber
      ): BigNumber => BigNumber.from(yeaPct).shl(64).or(nayPct).shl(128).or(voteId);
  

      const isValidVoteProportions = async (voterYeaPct: BigNumber, voterNayPct: BigNumber) => {
        const vote = await voting.getVote(voteId);
        // Creator voted yes when created the vote
        const voteCreatorStake = await token.balanceOf(voteCreator.address);
        const voterYeaStake = voterStake
          .mul(voterYeaPct)
          .div(pct16(100));
        const voterNayStake = voterStake
          .mul(voterNayPct)
          .div(pct16(100));

        expect(
          vote.yea,
          "Incorrect yea proportion"
        ).to.be.equal(voterYeaStake.add(voteCreatorStake));
        expect(vote.nay, "Incorrect nay proportion").to.be.equal(voterNayStake);
      };

      before("Prepare vote casting", async () => {
        console.log(" preparing vote casting");
        voterVoting = voting.connect(voter);
        voterStake = await token.balanceOf(voter.address);
      });

      describe("when casting a continuous vote", () => {
        it("should emit two correct CastVote events", async () => {
          const yeaPct = votePct(66);
          const nayPct = votePct(34);
          const voteData = encodeVoteData(voteId, yeaPct, nayPct);

          const vote = await voterVoting.vote(voteData, false, false);

          expect(vote)
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, true, voterStake.mul(yeaPct).div(pct16(100)));

          expect(vote)
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, false, voterStake.mul(nayPct).div(pct16(100)));
        });

        it("should cast the correct proportions of yea and nay", async () => {
          const voterYeaPct = votePct(73);
          const voterNayPct = votePct(100 - 73);
          const voteData = encodeVoteData(voteId, voterYeaPct, voterNayPct);

          await voterVoting.vote(voteData, false, false);

          await isValidVoteProportions(voterYeaPct, voterNayPct);
        });

        it("should cast the correct proportions of yea and nay when not all tokens are used", async () => {
          const voterYeaPct = votePct(20);
          const voterNayPct = votePct(50);
          const voteData = encodeVoteData(voteId, voterYeaPct, voterNayPct);

          await voterVoting.vote(voteData, false, false);

          await isValidVoteProportions(voterYeaPct, voterNayPct);
        });

        it("should return even as voter state when trying to cast a 50% vote", async () => {
          const voterYeaPct = votePct(50);
          const voterNayPct = votePct(50);
          const voteData = encodeVoteData(voteId, voterYeaPct, voterNayPct);
          await voterVoting.vote(voteData, false, false);

          expect(await voterVoting.getVoterState(voteId, voter.address)).to.be.equal(3); // 3 = Even
        });

        it("should revert when pctYea and pctNay exced 100%", async () => {
          const voterYeaPct = votePct(32);
          const voterNayPct = votePct(70);
          const voteData = encodeVoteData(voteId, voterYeaPct, voterNayPct);
  
          expect(voterVoting.vote(voteData, false, false)).to.be.revertedWith(
            "MALFORMED_CONTINUOUS_VOTE"
          );
        });
      });

      describe("when casting a continuous vote with votePct", () => {
        it("should emit two correct CastVote events", async () => {
          const yeaPct = votePct(66);
          const nayPct = votePct(34);
          const voteData = encodeVoteData(voteId, yeaPct, nayPct);

          const vote = await voterVoting.votePct(voteId, yeaPct, nayPct, false);

          expect(vote)
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, true, voterStake.mul(yeaPct).div(pct16(100)));

          expect(vote)
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, false, voterStake.mul(nayPct).div(pct16(100)));
        });

        it("should cast the correct proportions of yea and nay", async () => {
          const voterYeaPct = votePct(73);
          const voterNayPct = votePct(100 - 73);

          await voterVoting.votePct(voteId, voterYeaPct, voterNayPct, false);

          await isValidVoteProportions(voterYeaPct, voterNayPct);
        });

        it("should cast the correct proportions of yea and nay when not all tokens are used", async () => {
          const voterYeaPct = votePct(20);
          const voterNayPct = votePct(50);

          await voterVoting.votePct(voteId, voterYeaPct, voterNayPct, false);

          await isValidVoteProportions(voterYeaPct, voterNayPct);
        });

        it("should return even as voter state when trying to cast a 50% vote", async () => {
          const voterYeaPct = votePct(50);
          const voterNayPct = votePct(50);
          await voterVoting.votePct(voteId, voterYeaPct, voterNayPct, false);

          expect(await voterVoting.getVoterState(voteId, voter.address)).to.be.equal(3); // 3 = Even
        });

        it("should revert when pctYea and pctNay exced 100%", async () => {
          const voterYeaPct = votePct(32);
          const voterNayPct = votePct(70);
  
          expect(voterVoting.votePct(voteId, voterYeaPct, voterNayPct, false)).to.be.revertedWith(
            "MALFORMED_CONTINUOUS_VOTE"
          );
        });
      });

      // Backward-compatible check
      describe("when casting a discrete vote", () => {
        const yea = pct16(100);
        const nay = pct16(0);

        it("should emit a correct CastVote event when yay", async () => {
          expect(await voterVoting.vote(voteId, true, false))
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, true, voterStake);
        });

        it("should emit a correct CastVote event when nay", async () => {
          expect(await voterVoting.vote(voteId, false, false))
            .to.emit(voterVoting, "CastVote")
            .withArgs(voteId, voter.address, false, voterStake);
        });

        it("should cast a yea vote correctly", async () => {
          await voterVoting.vote(voteId, true, false);

          await isValidVoteProportions(yea, nay);
        });

        it("should cast a nay vote correctly", async () => {
          await voterVoting.vote(voteId, false, false);

          await isValidVoteProportions(nay, yea);
        });
      });

      it("should revert when trying to cast a vote that is simultaneously discrete and continuous", async () => {
        const voterYeaPct = votePct(32);
        const voterNayPct = votePct(68);
        const voteData = encodeVoteData(voteId, voterYeaPct, voterNayPct);

        expect(voterVoting.vote(voteData, true, false)).to.be.revertedWith(
          "MALFORMED_CONTINUOUS_VOTE"
        );
      });
    });
  });
});
